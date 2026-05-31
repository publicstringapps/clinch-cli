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
    return null; // Decryption failed (file moved to different machine or tampered)
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
    // Session might be deleted or errored, ignore gracefully in CLI
  }
}

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg) {
    console.error('Not initialized. Run: clinch init');
    process.exit(1);
  }
  return cfg;
}

function getClinchCore(cfg) {
  let ClinchCoreModule;
  try { ClinchCoreModule = require('clinch-core'); }
  catch {
    console.error('clinch-core not found. Ensure it is linked or installed.');
    process.exit(1);
  }
  const { ClinchCore } = ClinchCoreModule;
  const core = new ClinchCore({ registryUrl: cfg.registryUrl });

  // Dynamically hydrate ClinchCore memory with locally stored API keys
  const secrets = loadSecrets();
  for (const [domain, s] of Object.entries(secrets)) {
    core.registerSecret(domain, s.key, s.name);
  }

  core.on('log', msg => console.log(msg));
  core.on('error', err => console.error('Error:', err.message));

  return core;
}

// ── Prompt Helper ─────────────────────────────────────────────
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

// ── Conversational AI Intent Parser (CLI Layer) ───────────────
async function parseIntentWithLLM(userInput, modelPath) {
  console.log(c.dim("\n[Agent Q] Booting local parser model to analyze your request..."));
  let nodeLlama;
  try { nodeLlama = await import('node-llama-cpp'); }
  catch (e) {
    console.error(c.red("\nError: node-llama-cpp is required for conversational parsing."));
    console.error("Please run: npm install -g node-llama-cpp\n");
    process.exit(1);
  }

  const resolvedPath = path.resolve(modelPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(c.red(`\nError: Model not found at ${resolvedPath}`));
    process.exit(1);
  }

  const llama = await nodeLlama.getLlama();
  const model = await llama.loadModel({ modelPath: resolvedPath });
  const context = await model.createContext({ contextSize: 2048, threads: Math.max(1, os.cpus().length - 1) });

  const systemPrompt = `You are a structured data extractor. Convert the user's conversational intent into a strict JSON schema.
Your response MUST be ONLY valid JSON matching this schema exactly. Do not output conversational text.

JSON Schema:
{
  "intent": "purchase",
  "category": "string (e.g. domain_name, electronics, kitchen_appliance)",
  "item": "string (the exact item, website, or product they want)",
  "max_budget": number (extract budget numeric value),
  "must_haves": ["array", "of", "strings", "representing", "conditions", "like", "WHOIS privacy", "warranty"]
}`;

  const session = new nodeLlama.LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: systemPrompt,
    chatWrapper: new nodeLlama.ChatMLChatWrapper()
  });

  let responseText = "";
  await session.prompt(userInput, { maxTokens: 1500, onTextChunk: (chunk) => { responseText += chunk; } });

  try {
    const cleanJson = responseText.replace(/```json|```/g, "").trim();
    return JSON.parse(cleanJson);
  } catch (e) {
    console.error(c.red("Failed to parse intent. Falling back to manual entry."));
    return null;
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
  .option('--model <path>', 'Path to custom GGUF model')
  .action(async (opts) => {
    banner();
    console.log(c.bold('Setting up your Clinch agent...\n'));

    const existing = loadConfig();
    if (existing) {
      const overwrite = await prompt('Config already exists. Overwrite? (y/N): ');
      if (overwrite.toLowerCase() !== 'y') { console.log('Aborted.'); process.exit(0); }
    }

    const registryUrl = opts.registry || 'https://everydaytok-agentq-core-logics.hf.space';
    const modelPath   = opts.model || path.join(CONFIG_DIR, 'model.gguf');

    console.log(c.yellow('Connecting to registry and completing PoW handshake...'));

    const core = getClinchCore({ registryUrl });
    await core.initialize();

    const config = {
      registryUrl,
      modelPath,
      pubKey:  core.identityPubKey,
      token:   core.jwtToken,
      mode:    'ANP/A',
      localOnly: false,
      createdAt: new Date().toISOString()
    };

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
  .option('--category <name>', 'Market category (Triggers cascade negotiation across matching sellers if address is omitted)')
  .option('--squeeze <n>', 'Number of sellers to sequentially squeeze (Low urgency / price optimization)', '3')
  .option('--parallel <n>', 'Number of sellers to negotiate with simultaneously in parallel (High urgency / ride-hailing)')
  .option('--auto', 'Run sandbox auto-negotiation')
  .action(async (address, opts) => {
    const cfg = requireConfig();
    let targetAddress = address;
    let budget = opts.budget;
    let constraints = {};

    // ── WIZARD MODE ──
    if (!targetAddress && !opts.category && !budget) {
      banner();
      console.log(c.bold("💬 Clinch Onboarding Wizard — Tell me what you're looking for.\n"));

      const naturalIntent = await prompt("👉 Describe what you want to negotiate\n" +
        c.dim("   (e.g., 'Get me the domain cartpost.shop under 80 dollars')\n\n💬: "));

      if (!naturalIntent) process.exit(1);

      const parsed = await parseIntentWithLLM(naturalIntent, cfg.modelPath);
      if (!parsed) {
        console.error(c.red("✗ Error parsing constraints. Please try manual entry."));
        process.exit(1);
      }

      console.log(c.bold("\n📊 Extracted Intention Context:"));
      console.log(`  - Category:   ${c.cyan(parsed.category)}`);
      console.log(`  - Target Item: ${c.cyan(parsed.item)}`);
      console.log(`  - Max Budget:  ${c.green("$" + parsed.max_budget)}\n`);

      const confirm = await prompt("👉 Is this correct? (Y/n): ");
      if (confirm.toLowerCase() === 'n') process.exit(0);

      constraints = parsed;
      budget = parsed.max_budget;

      console.log(c.dim(`\nQuerying registry for category "${parsed.category}"...`));
      const coreDiscovery = getClinchCore(cfg);
      await coreDiscovery.initialize(cfg.token);
      const results = await coreDiscovery.search(parsed.category);
      coreDiscovery.disconnect();

      const sellers = results.results || [];
      if (sellers.length === 0) {
        console.log(c.yellow(`\nNo sellers found for "${parsed.category}".`));
        targetAddress = await prompt("👉 Enter address manually (e.g. ANP/C.amazon.anp): ");
      } else {
        console.log(c.bold(`\nAvailable sellers:`));
        sellers.forEach((s, idx) => console.log(`  ${idx + 1}. ${c.cyan(s.agent_id)}`));
        const selection = await prompt(`\n👉 Select a seller (1-${sellers.length}): `);
        targetAddress = `ANP/C.${sellers[parseInt(selection) - 1].agent_id}`;
      }
    } else {
      constraints = {
        intent: 'purchase',
        item: opts.item || 'Item',
        max_budget: parseFloat(budget || 100)
      };
      if (opts.category) constraints.category = opts.category;
    }

    let runAuto = opts.auto;
    if (runAuto === undefined) {
      const autoInput = await prompt("\n👉 Let Agent Q negotiate autonomously? (Y/n): ");
      runAuto = autoInput.toLowerCase() !== 'n';
    }

    const core = getClinchCore(cfg);

    // ── CASCADING ITERATIVE CASCADE TRIGGER (Sequential Squeeze vs. Parallel Concurrency) ──
    if (!targetAddress && opts.category) {
        let maxSellers = 3;
        let strategy = 'sequential';

        if (opts.parallel && !opts.squeeze) {
            maxSellers = parseInt(opts.parallel);
            strategy = 'parallel';
            console.log(c.yellow(`🤖 Parallel Mode: Handshaking concurrently with top ${maxSellers} sellers for "${opts.category}"...\n`));
        } else {
            maxSellers = parseInt(opts.squeeze || '3');
            strategy = 'sequential';
            console.log(c.yellow(`🤖 Squeeze Mode: Sequentially bargaining across top ${maxSellers} sellers for "${opts.category}"...\n`));
        }

        if (runAuto) {
            await core.sandbox({ modelPath: cfg.modelPath });
        } else {
            await core.initialize(cfg.token);
        }

        const bestDeal = await core.negotiateCascade(opts.category, constraints, maxSellers, strategy);

        if (bestDeal) {
            console.log(c.green(c.bold(`\n🏆 CASCADE COMPLETE: Secured optimal deal with ${bestDeal.sellerId} at $${bestDeal.finalPrice}!`)));
        } else {
            console.log(c.red(`\n✗ Cascade completed without any successful deals.`));
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

    if (runAuto) {
      console.log(c.yellow('🤖 Auto-mode: Local LLM sandbox active.\n'));
      await core.sandbox({ modelPath: cfg.modelPath });
    } else {
      await core.initialize(cfg.token);
    }

    core.on('session_started', ({ sessionId }) => {
      console.log(c.green(`\n✓ Session started: ${c.bold(sessionId)}`));
      saveSessionState(sessionId, core);
    });

    core.on('callback_received', ({ sessionId }) => saveSessionState(sessionId, core));

    core.on('session_closed', ({ sessionId, outcome, finalPrice }) => {
      saveSessionState(sessionId, core);
      if (outcome === 'deal') {
        console.log(c.green(c.bold(`\n🎉 DEAL SECURED at $${finalPrice}`)));
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
      console.log(c.bold('\nManual mode — type a price to counter, or "exit" / "accept":\n'));
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.on('line', async (cmd) => {
        if (cmd === 'exit') {
          await core.exitSession(sessionId);
          saveSessionState(sessionId, core);
          process.exit(0);
        }
        else if (cmd === 'accept') { console.log(c.green(`Accepting...`)); rl.close(); }
        else {
          const price = parseFloat(cmd);
          if (!isNaN(price)) {
              await core.sendCounter(sessionId, price, 'Counter offer');
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
    const cfg = requireConfig();
    const sessions = loadSessions();

    if (!sessions[sessionId]) {
      console.error(c.red(`Session ${sessionId} not found in local store.`));
      process.exit(1);
    }

    console.log(c.yellow(`\nRehydrating Session ${c.bold(sessionId)}...\n`));
    const core = getClinchCore(cfg);

    if (opts.auto) {
        await core.sandbox({ modelPath: cfg.modelPath });
    } else {
        await core.initialize(cfg.token);
    }

    core.importSessionState(sessions[sessionId].state);

    core.on('callback_received', ({ id }) => saveSessionState(id, core));
    core.on('session_closed', ({ outcome, finalPrice }) => {
      saveSessionState(sessionId, core);
      if (outcome === 'deal') console.log(c.green(c.bold(`\n🎉 DEAL SECURED at $${finalPrice}`)));
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
        console.log(`  - ${c.cyan(domain)} (${c.dim(s.name || 'unnamed')})`);
      });
      console.log('');
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
