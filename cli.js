#!/usr/bin/env node

// ============================================================
// clinch-cli — Clinch Protocol Command Line Client
// Usage: clinch <command> [options]
// ============================================================
const { program } = require('commander');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const crypto = require('crypto');
const https = require('https');

const CONFIG_DIR  = path.join(os.homedir(), '.clinch');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');
const DEALS_FILE  = path.join(CONFIG_DIR, 'deals.json');
const SECRETS_FILE = path.join(CONFIG_DIR, 'secrets.json');

// ── Cryptographic Key Vault Helpers (Blind Key Pass) ─────────
function getEncryptionKey() {
  const salt = 'clinch-local-secret-salt-398457';
  const machineId = os.hostname() + os.arch() + os.platform() + os.userInfo().username;
  return crypto.pbkdf2Sync(machineId, salt, 10000, 32, 'sha256');
}

function encrypt(text) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return JSON.stringify({ iv: iv.toString('hex'), data: encrypted, tag: authTag });
}

function decrypt(encJson) {
  try {
    const key = getEncryptionKey();
    const { iv, data, tag } = JSON.parse(encJson);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    let decrypted = decipher.update(data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return null;
  }
}

function loadSecrets() {
  if (!fs.existsSync(SECRETS_FILE)) return {};
  try {
    const encryptedRaw = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
    const decrypted = {};
    for (const [domain, payload] of Object.entries(encryptedRaw)) {
      const decryptedValue = decrypt(payload.encValue);
      if (decryptedValue) {
        decrypted[domain] = { key: decryptedValue, name: payload.name };
      }
    }
    return decrypted;
  } catch {
    return {};
  }
}

function saveSecrets(secrets) {
  const encryptedRaw = {};
  for (const [domain, payload] of Object.entries(secrets)) {
    encryptedRaw[domain] = {
      name: payload.name,
      encValue: encrypt(payload.key)
    };
  }
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(encryptedRaw, null, 2), { mode: 0o600 });
}

// ── Config & Session Persistence Helpers ──────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return {};
  return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
}

function saveSessionState(sessionId, core) {
  try {
    const serialized = core.exportSessionState(sessionId);
    const sessions = loadSessions();
    sessions[sessionId] = {
      updatedAt: new Date().toISOString(),
      state: serialized
    };
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (e) {
    // Ignore gracefully
  }
}

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg) {
    console.error(c.red('Not initialized. Run: clinch init'));
    process.exit(1);
  }
  return cfg;
}

function getClinchCore(cfg) {
  let ClinchCoreModule;
  try { ClinchCoreModule = require('clinch-core'); }
  catch {
    console.error(c.red('clinch-core not found. Ensure it is linked or installed.'));
    process.exit(1);
  }
  const { ClinchCore } = ClinchCoreModule;
  const core = new ClinchCore({ registryUrl: cfg.registryUrl });

  const secrets = loadSecrets();
  for (const [domain, s] of Object.entries(secrets)) {
    core.registerSecret(domain, s.key, s.name);
  }

  core.on('log', msg => console.log(msg));
  core.on('error', err => console.error(c.red('Error:'), err.message));

  return core;
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

// ── AI Engine Orchestration (Ollama vs GGUF) ──────────────────
async function ensureAIEngine(cfg) {
  if (cfg.engine) return cfg;

  console.log(c.bold("\n🤖 Local AI Engine Setup"));
  console.log(c.dim("Agent Q requires a local AI to parse intents and auto-negotiate."));
  
  const choice = await prompt("Which engine would you like to use?\n  1) Ollama (Recommended - Requires Ollama running locally)\n  2) Standalone GGUF (Downloads ~1.1GB model)\n👉 (1/2): ");

  if (choice === '1') {
    cfg.engine = 'ollama';
    const model = await prompt("👉 Enter Ollama model name (default: llama3): ");
    cfg.ollamaModel = model || 'llama3';
  } else {
    cfg.engine = 'gguf';
    const dl = await prompt("👉 Download default Qwen 1.5B model? (Y/n): ");
    if (dl.toLowerCase() !== 'n') {
       cfg.ggufUrl = "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf";
    } else {
       cfg.ggufUrl = await prompt("👉 Enter custom GGUF download URL: ");
    }
  }
  
  saveConfig(cfg);
  return cfg;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (currentUrl) => {
      https.get(currentUrl, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          return request(response.headers.location);
        }
        if (response.statusCode !== 200) {
          return reject(new Error(`Download failed: ${response.statusCode}`));
        }
        const total = parseInt(response.headers['content-length'], 10);
        let downloaded = 0;
        response.on('data', (chunk) => {
          downloaded += chunk.length;
          const msg = total ? `${((downloaded / total) * 100).toFixed(1)}%` : `${(downloaded / 1024 / 1024).toFixed(1)} MB`;
          process.stdout.write(`\r${c.yellow('Downloading model...')} ${msg}`);
        });
        response.pipe(file);
        file.on('finish', () => {
          console.log(c.green("\n✓ Download complete!"));
          file.close(resolve);
        });
      }).on('error', (err) => {
        fs.unlink(dest, () => reject(err));
      });
    };
    request(url);
  });
}

// Global cache to prevent reloading the 1.1GB model on every chat turn
let cachedLlamaModel = null;
let cachedLlamaContext = null;

async function promptAI(systemPrompt, userText, cfg) {
  if (cfg.engine === 'ollama') {
    try {
      const res = await fetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.ollamaModel || 'llama3',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userText }
          ],
          stream: false
        })
      });
      if (!res.ok) throw new Error(`Ollama returned status ${res.status}`);
      const data = await res.json();
      return data.message.content;
    } catch (e) {
      console.error(c.red(`\n[!] Ollama request failed: ${e.message}`));
      console.error(c.dim(`Please ensure Ollama is running (http://127.0.0.1:11434) and the model is pulled.`));
      process.exit(1);
    }
  } else {
    // GGUF Execution
    const resolvedPath = path.resolve(cfg.modelPath || path.join(CONFIG_DIR, 'model.gguf'));
    if (!fs.existsSync(resolvedPath)) {
      console.log(c.yellow(`\nModel not found at ${resolvedPath}`));
      await downloadFile(cfg.ggufUrl || "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf", resolvedPath);
    }

    let nodeLlama;
    try { nodeLlama = await import('node-llama-cpp'); }
    catch (e) {
      console.error(c.red("\nError: 'node-llama-cpp' is required for GGUF execution."));
      console.error("Run: npm install -g node-llama-cpp");
      process.exit(1);
    }

    if (!cachedLlamaModel) {
      const threads = Math.max(2, os.cpus().length - 1);
      console.log(c.dim(`\n[Agent Q] Loading GGUF model into memory using ${threads} threads (this may take a few seconds)...`));
      
      const llama = await nodeLlama.getLlama();
      cachedLlamaModel = await llama.loadModel({ modelPath: resolvedPath });
      cachedLlamaContext = await cachedLlamaModel.createContext({ contextSize: 2048, threads: threads });
      
      console.log(c.dim(`[Agent Q] Model loaded. Analyzing...`));
    }

    const session = new nodeLlama.LlamaChatSession({
      contextSequence: cachedLlamaContext.getSequence(),
      systemPrompt: systemPrompt,
      chatWrapper: new nodeLlama.ChatMLChatWrapper()
    });

    let responseText = "";
    await session.prompt(userText, { maxTokens: 1500, onTextChunk: (chunk) => { responseText += chunk; } });
    return responseText;
  }
}

async function parseIntentWithLLM(userInput, cfg) {
  const systemPrompt = `You are a structured data extractor for a smart network agent.
Analyze the user's input. They might want to purchase an item, schedule a P2P service, book something, or query a node.

If the user says a greeting (like "hi" or "hello") or their request is too vague to act on, output EXACTLY this JSON:
{"error": "Please specify what you want to do (e.g. 'Get me a laptop under $500', or 'Schedule a call with @algeru on ginger')."}

If they DO specify a clear intent (purchase, scheduling, booking, data retrieval), output EXACTLY this JSON schema:
{
  "intent": "string (e.g. purchase, schedule, booking)",
  "category": "string (e.g. electronics, scheduling, p2p_services, domain_names)",
  "item": "string (the actual item, target, or service requested)",
  "max_budget": number (integer representing max budget. If none mentioned, use 0)
}
Your response MUST be ONLY valid JSON. Do not include conversational text.`;

  try {
    const rawRes = await promptAI(systemPrompt, userInput, cfg);
    const cleanJson = rawRes.replace(/```json|```/g, "").trim();
    
    const parsed = JSON.parse(cleanJson);
    
    // Allow the loop to catch errors and reprompt the user interactively
    if (parsed.error) {
        return { error: parsed.error };
    }
    
    if (!parsed.item) {
        return { error: "I couldn't figure out the exact item or service you want. Please be specific!" };
    }
    
    return parsed;
  } catch (e) {
    return { error: "Failed to parse intent correctly. Please try formatting your request more simply." };
  }
}

// ── Color & Banner helpers ────────────────────────────────────
const c = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
};

function banner() {
  console.log(c.cyan(c.bold(`
  ██████╗██╗     ██╗███╗   ██╗ ██████╗██╗  ██╗
 ██╔════╝██║     ██║████╗  ██║██╔════╝██║  ██║
 ██║     ██║     ██║██╔██╗ ██║██║     ███████║
 ██║     ██║     ██║██║╚██╗██║██║     ██╔══██║
 ╚██████╗███████╗██║██║ ╚████║╚██████╗██║  ██║
  ╚═════╝╚══════╝╚═╝╚═╝  ╚═══╝ ╚═════╝╚═╝  ╚═╝
  `)));
  console.log(c.dim('  Agent Negotiation Protocol — v0.1.0\n'));
}

// ============================================================
// COMMANDS
// ============================================================

program
  .command('init')
  .description('Initialize your Clinch buyer agent')
  .option('--registry <url>', 'Custom registry URL')
  .action(async (opts) => {
    banner();
    console.log(c.bold('Setting up your Clinch agent...\n'));

    let config = loadConfig() || {};
    if (config.pubKey) {
      const overwrite = await prompt('Config already exists. Overwrite network identity? (y/N): ');
      if (overwrite.toLowerCase() !== 'y') { console.log('Aborted.'); process.exit(0); }
    }

    config.registryUrl = opts.registry || 'https://everydaytok-agentq-core-logics.hf.space';
    config.modelPath = path.join(CONFIG_DIR, 'model.gguf');
    config = await ensureAIEngine(config);

    console.log(c.yellow('\nConnecting to registry and completing PoW handshake...'));

    const core = getClinchCore(config);
    await core.initialize();

    config.pubKey = core.identityPubKey;
    config.token = core.jwtToken;
    config.mode = 'ANP/A';
    config.createdAt = new Date().toISOString();

    saveConfig(config);
    core.disconnect();

    console.log('\n' + c.green('✓ Agent initialized successfully'));
    console.log(c.dim(`  Public key: ${config.pubKey.substring(0,16)}...`));
    
    console.log('\n' + c.bold('🚀 Next Steps:'));
    console.log(`  1. Start a natural language negotiation:  ${c.cyan('clinch negotiate')}`);
    console.log(`  2. Search the network for sellers:        ${c.cyan('clinch query "electronics"')}`);
    console.log(`  3. Manage blind API key vaults:           ${c.cyan('clinch key')}`);
    
    process.exit(0);
  });

program
  .command('query')
  .description('Search for seller agents on the network')
  .argument('<category>', 'Category to search')
  .option('--mode <mode>', 'Filter by protocol mode')
  .action(async (category, opts) => {
    const cfg = requireConfig();
    const core = getClinchCore(cfg);
    console.log(c.cyan(`\nSearching for ${c.bold(category)} sellers...\n`));

    await core.initialize(cfg.token);
    const results = await core.search(category, opts.mode);
    core.disconnect();

    const sellers = results.results || [];
    if (!sellers.length) {
      console.log(c.yellow('No sellers found for this category.'));
      process.exit(0);
    }

    console.log(c.bold(`Found ${sellers.length} seller(s):\n`));
    sellers.forEach((s, i) => {
      const tier = s.verification_tier === 'verified' ? c.green('✓ Verified') : c.dim('Unverified');
      console.log(`  ${c.bold((i+1) + '.')} ${c.cyan(s.agent_id)} (${tier})`);
      console.log(`     ANP address: ${c.yellow('ANP/C.' + s.agent_id)}`);
      console.log(`     Modes: ${(s.supported_modes || []).join(', ')}`);
    });
    
    process.exit(0);
  });

program
  .command('negotiate')
  .description('Start a negotiation with a seller agent')
  .argument('[address]', 'ANP address — format: MODE.domain.anp (e.g. ANP/C.amazon.anp)')
  .option('--budget <n>', 'Max budget (USD)')
  .option('--item <name>', 'Specific item to negotiate')
  .option('--category <name>', 'Market category (Triggers cascade negotiation across matching sellers)')
  .option('--squeeze <n>', 'Number of sellers to sequentially squeeze', '3')
  .option('--parallel <n>', 'Number of sellers to negotiate with simultaneously')
  .option('--auto', 'Run CLI-driven LLM auto-negotiation')
  .action(async (address, opts) => {
    let cfg = requireConfig();
    let targetAddress = address;
    let budget = opts.budget;
    let constraints = {};

    // ── WIZARD MODE ──
    if (!targetAddress && !opts.category && !budget) {
      banner();
      console.log(c.bold("💬 Clinch Onboarding Wizard — Tell me what you're looking for.\n"));

      cfg = await ensureAIEngine(cfg);

      let naturalIntent = await prompt("👉 Describe what you want to negotiate\n" +
        c.dim("   (e.g., 'Get me the domain cartpost.shop under 80 dollars')\n\n💬: "));

      // Conversational loop: keeps asking until a valid intent is parsed
      while (true) {
        if (!naturalIntent) process.exit(1);

        const parsed = await parseIntentWithLLM(naturalIntent, cfg);
        
        if (!parsed) {
            naturalIntent = await prompt(c.yellow("\n[Agent Q] Something went wrong. Let's try again. What are you looking for?\n💬: "));
            continue;
        }

        if (parsed.error) {
            naturalIntent = await prompt(c.yellow(`\n[Agent Q] ${parsed.error}\n💬: `));
            continue;
        }

        console.log(c.bold("\n📊 Extracted Intention Context:"));
        console.log(`  - Intent:     ${c.cyan(parsed.intent || 'purchase')}`);
        console.log(`  - Category:   ${c.cyan(parsed.category)}`);
        console.log(`  - Target Item: ${c.cyan(parsed.item)}`);
        console.log(`  - Max Budget:  ${c.green("$" + parsed.max_budget)}\n`);

        const confirm = await prompt("👉 Is this correct? (Y/n): ");
        if (confirm.toLowerCase() === 'n') {
            naturalIntent = await prompt(c.yellow("\n[Agent Q] Got it. Let's try again. What are you looking for?\n💬: "));
            continue;
        }

        constraints = parsed;
        budget = parsed.max_budget;
        break; // Exit loop on confirmation
      }

      console.log(c.dim(`\n[Network] Querying registry for category "${constraints.category}"...`));
      const coreDiscovery = getClinchCore(cfg);
      await coreDiscovery.initialize(cfg.token);
      const results = await coreDiscovery.search(constraints.category);
      coreDiscovery.disconnect();

      const sellers = results.results || [];
      if (sellers.length === 0) {
        console.log(c.yellow(`\nNo sellers found for "${constraints.category}".`));
        targetAddress = await prompt("👉 Enter address manually (e.g. ANP/C.amazon.anp): ");
      } else {
        console.log(c.bold(`\nAvailable sellers:`));
        sellers.forEach((s, idx) => console.log(`  ${idx + 1}. ${c.cyan(s.agent_id)}`));
        const selection = await prompt(`\n👉 Select a seller (1-${sellers.length}): `);
        targetAddress = `ANP/C.${sellers[parseInt(selection) - 1].agent_id}`;
      }
    } else {
      constraints = { intent: 'purchase', item: opts.item || 'Item', max_budget: parseFloat(budget || 100) };
      if (opts.category) constraints.category = opts.category;
    }

    let runAuto = opts.auto;
    if (runAuto === undefined) {
      const autoInput = await prompt("\n👉 Let Agent Q negotiate autonomously? (Y/n): ");
      runAuto = autoInput.toLowerCase() !== 'n';
    }

    if (runAuto) {
      cfg = await ensureAIEngine(cfg);
    }

    const core = getClinchCore(cfg);

    // ── CLI AUTO-NEGOTIATION HOOK ──
    if (runAuto) {
      console.log(c.yellow(`\n🤖 Auto-mode initialized. Routing inference through: ${c.bold(cfg.engine)}`));
      
      core.on('callback_received', async ({ sessionId, payload }) => {
        const session = core.getSession(sessionId);
        if (!session) return;
        session.currentTurn++;

        const incomingMessage = payload.message || JSON.stringify(payload);
        
        const priceMatch = incomingMessage.match(/price\s*:\s*\$?(\d+(?:\.\d{2})?)/i);
        if (priceMatch) session.lastKnownPrice = parseFloat(priceMatch[1]);

        if (session.lastKnownPrice > 0 && session.lastKnownPrice <= session.constraints.max_budget) {
            console.log(c.green(`\n🎉 [Agent Q] Target met constraints! Securing deal.`));
            await core.sendCounter(sessionId, session.lastKnownPrice, "I accept this offer.");
            return;
        }

        if (session.currentTurn > 6) {
             console.log(c.red(`\n🛑 [Agent Q] Max turns reached. Exiting.`));
             await core.exitSession(sessionId);
             return;
        }

        const promptStr = core.buildAgentPrompt(sessionId, incomingMessage);
        
        console.log(c.dim(`\n[Agent Q] Evaluating turn ${session.currentTurn}...`));
        const aiResponse = await promptAI(promptStr, incomingMessage, cfg);
        
        let price = null;
        let msg = "Counter offer / Clarification requested";
        
        try {
            const clean = aiResponse.replace(/```json|```/g, "").trim();
            const parsed = JSON.parse(clean);
            if (parsed.price) price = parsed.price;
            if (parsed.message) msg = parsed.message;
        } catch(e) {
            const fallback = aiResponse.match(/"price"\s*:\s*(\d+(?:\.\d{2})?)/i);
            if (fallback) price = parseFloat(fallback[1]);
        }

        if (price) {
            await core.sendCounter(sessionId, Math.min(price, session.constraints.max_budget), msg);
        } else {
            console.log(c.yellow(`[Agent Q] Sending safe fallback response.`));
            await core.sendCounter(sessionId, session.lastKnownPrice * 0.9 || 0, "Can you provide more details?");
        }
      });
    }

    // ── CASCADING ITERATIVE CASCADE TRIGGER ──
    if (!targetAddress && opts.category) {
        let maxSellers = 3;
        let strategy = 'sequential';

        if (opts.parallel && !opts.squeeze) {
            maxSellers = parseInt(opts.parallel);
            strategy = 'parallel';
            console.log(c.yellow(`🤖 Parallel Mode: Handshaking concurrently with top ${maxSellers} nodes for "${opts.category}"...\n`));
        } else {
            maxSellers = parseInt(opts.squeeze || '3');
            strategy = 'sequential';
            console.log(c.yellow(`🤖 Squeeze Mode: Sequentially communicating across top ${maxSellers} nodes for "${opts.category}"...\n`));
        }

        await core.initialize(cfg.token);
        const bestDeal = await core.negotiateCascade(opts.category, constraints, maxSellers, strategy);

        if (bestDeal) {
            console.log(c.green(c.bold(`\n🏆 CASCADE COMPLETE: Secured optimal agreement with ${bestDeal.sellerId} at $${bestDeal.finalPrice}!`)));
        } else {
            console.log(c.red(`\n✗ Cascade completed without any successful agreements.`));
        }
        process.exit(0);
    }

    // ── STANDARD ONE-ON-ONE HANDSHAKE ──
    if (targetAddress && !targetAddress.startsWith('ANP/')) {
        console.error(c.red(`\n✗ Invalid Address: ${targetAddress}`));
        console.error("  Address MUST include the protocol mode prefix.");
        console.error("  Example: ANP/C.amazon.anp\n");
        process.exit(1);
    }

    await core.initialize(cfg.token);

    core.on('session_started', ({ sessionId }) => {
      console.log(c.green(`\n✓ Session started: ${c.bold(sessionId)}`));
      saveSessionState(sessionId, core);
    });

    if (!runAuto) {
        core.on('callback_received', ({ sessionId, payload }) => {
            saveSessionState(sessionId, core);
            console.log(c.cyan(`\n💬 Node says:`), payload);
            console.log(c.dim(`\nType a price/response to counter, or "exit" / "accept":`));
        });
    }

    core.on('session_closed', ({ sessionId, outcome, finalPrice }) => {
      saveSessionState(sessionId, core);
      if (outcome === 'deal') {
        console.log(c.green(c.bold(`\n🎉 AGREEMENT SECURED at $${finalPrice}`)));
        process.exit(0);
      }
    });

    core.on('status_changed', status => {
      if (status === 'STALEMATE') {
          console.log(c.red('\n✗ Stalemate. Exiting.'));
          process.exit(0);
      }
    });

    const sessionId = await core.negotiate(targetAddress, constraints);

    if (!runAuto) {
      console.log(c.bold('\nManual mode — await response, then type a counter-offer, or "exit" / "accept".\n'));
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.on('line', async (cmd) => {
        if (cmd === 'exit') {
          await core.exitSession(sessionId);
          saveSessionState(sessionId, core);
          process.exit(0);
        }
        else if (cmd === 'accept') { console.log(c.green(`Accepting...`)); }
        else {
          const price = parseFloat(cmd);
          if (!isNaN(price)) {
              await core.sendCounter(sessionId, price, 'Counter offer');
              saveSessionState(sessionId, core);
          } else {
              // Allows sending non-numeric replies if needed
              await core.sendCounter(sessionId, 0, cmd);
              saveSessionState(sessionId, core);
          }
        }
      });
    }
  });

program
  .command('sessions')
  .description('List saved negotiation sessions')
  .action(() => {
    const sessions = loadSessions();
    const ids = Object.keys(sessions);
    if (ids.length === 0) {
      console.log(c.yellow('No saved sessions found.'));
      process.exit(0);
    }

    console.log(c.bold(`Found ${ids.length} session(s):\n`));
    ids.forEach(id => {
      const s = JSON.parse(sessions[id].state);
      console.log(`  ${c.cyan(id)} - Target: ${s.sellerId} | Status: ${c.bold(s.status)} | Turn: ${s.currentTurn}`);
    });
    
    process.exit(0);
  });

program
  .command('resume')
  .description('Resume a dropped or asynchronous negotiation session')
  .argument('<sessionId>', 'The session ID to resume')
  .option('--auto', 'Resume with auto-negotiation')
  .action(async (sessionId, opts) => {
    let cfg = requireConfig();
    const sessions = loadSessions();

    if (!sessions[sessionId]) {
      console.error(c.red(`Session ${sessionId} not found in local store.`));
      process.exit(1);
    }

    console.log(c.yellow(`\nRehydrating Session ${c.bold(sessionId)}...\n`));
    if (opts.auto) {
        cfg = await ensureAIEngine(cfg);
    } 

    const core = getClinchCore(cfg);
    await core.initialize(cfg.token);

    core.importSessionState(sessions[sessionId].state);

    core.on('callback_received', ({ id }) => saveSessionState(id, core));
    core.on('session_closed', ({ outcome, finalPrice }) => {
      saveSessionState(sessionId, core);
      if (outcome === 'deal') console.log(c.green(c.bold(`\n🎉 AGREEMENT SECURED at $${finalPrice}`)));
      process.exit(0);
    });

    console.log(c.green('✓ State rehydrated. Listening for webhooks/callbacks...\n'));
    if (!opts.auto) {
        console.log(c.dim('Awaiting remote updates. Press Ctrl+C to detach.'));
    }
  });

// ── KEY VAULT COMMANDS (Blind Key Pass Management) ───────────
program
  .command('key')
  .description('Manage third-party API credentials (Blind Key Pass vault)')
  .option('--set', 'Interactively save a new API key credential')
  .option('--list', 'List domains with registered local credentials')
  .option('--remove <domain>', 'Delete a credential from your local vault')
  .option('--show', 'Display the raw API keys when listing')
  .action(async (opts) => {
    const cfg = requireConfig();
    const secrets = loadSecrets();

    if (opts.remove) {
      const domain = opts.remove.toLowerCase().trim();
      if (secrets[domain]) {
        delete secrets[domain];
        saveSecrets(secrets);
        console.log(c.green(`✓ Credential vault cleared for domain: ${domain}`));
      } else {
        console.log(c.yellow(`No credential found for domain: ${domain}`));
      }
      process.exit(0);
    }

    if (opts.list) {
      const entries = Object.entries(secrets);
      if (entries.length === 0) {
        console.log(c.yellow('Your Blind Key Pass vault is empty.'));
        process.exit(0);
      }
      console.log(c.bold('\n🔑 Registered Blind Key Credentials:\n'));
      entries.forEach(([domain, s]) => {
        if (opts.show) {
            console.log(`  - ${c.cyan(domain)} (${c.dim(s.name || 'unnamed')}) -> ${c.yellow(s.key)}`);
        } else {
            console.log(`  - ${c.cyan(domain)} (${c.dim(s.name || 'unnamed')}) -> ${c.dim('••••••••••••')}`);
        }
      });
      console.log(c.dim(opts.show ? '' : '\n(Run with --show to view raw keys)'));
      process.exit(0);
    }

    // Default: Interactive configuration
    console.log(c.bold('\n🔑 Register a local Blind Key Pass credential'));
    console.log(c.dim('   Your credentials are AES-GCM encrypted and bound to this hardware locally.\n'));

    const domain = await prompt('👉 Target Domain (e.g. apify.anp): ');
    if (!domain) process.exit(0);
    const normalizedDomain = domain.toLowerCase().trim();

    const name = await prompt('👉 Key Label (e.g. Apify Production Token): ');
    const value = await prompt('👉 Secret Value / API Key: ');
    if (!value) process.exit(0);

    secrets[normalizedDomain] = { key: value, name: name || 'Unnamed Key' };
    saveSecrets(secrets);

    console.log(c.green(`\n✓ Key registered! Handshakes targeting ${normalizedDomain} will silently inject this token.`));
    process.exit(0);
  });

program
  .name('clinch')
  .description('Clinch Protocol — Agent Negotiation CLI')
  .version('0.1.0');

program.parse();
