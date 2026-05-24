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

const CONFIG_DIR  = path.join(os.homedir(), '.clinch');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');

// ── Persistence Helpers ───────────────────────────────────────
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
      if (overwrite.toLowerCase() !== 'y') { console.log('Aborted.'); return; }
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
    if (!sellers.length) return console.log(c.yellow('No sellers found for this category.'));

    console.log(c.bold(`Found ${sellers.length} seller(s):\n`));
    sellers.forEach((s, i) => {
      const tier = s.verification_tier === 'verified' ? c.green('✓ Verified') : c.dim('Unverified');
      console.log(`  ${c.bold((i+1) + '.')} ${c.cyan(s.agent_id)} (${tier})`);
      console.log(`     ANP address: ${c.yellow('ANP/C.' + s.agent_id)}`);
      console.log(`     Modes: ${(s.supported_modes || []).join(', ')}`);
    });
  });

program
  .command('negotiate')
  .description('Start a negotiation with a seller agent')
  .argument('[address]', 'ANP address — format: MODE.domain.anp (e.g. ANP/A.amazon.anp)')
  .option('--budget <n>', 'Max budget (USD)')
  .option('--auto', 'Run sandbox auto-negotiation')
  .action(async (address, opts) => {
    const cfg = requireConfig();
    let targetAddress = address;
    let budget = opts.budget;
    let constraints = {};

    // ── WIZARD MODE ──
    if (!targetAddress || !budget) {
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
        targetAddress = await prompt("👉 Enter address manually (e.g. ANP/A.amazon.anp): ");
      } else {
        console.log(c.bold(`\nAvailable sellers:`));
        sellers.forEach((s, idx) => console.log(`  ${idx + 1}. ${c.cyan(s.agent_id)}`));
        const selection = await prompt(`\n👉 Select a seller (1-${sellers.length}): `);
        targetAddress = `ANP/C.${sellers[parseInt(selection) - 1].agent_id}`;
      }
    } else {
      constraints = { intent: 'purchase', item: 'Item', max_budget: parseFloat(budget) };
    }

    if (!targetAddress.startsWith('ANP/')) {
        console.error(c.red(`\n✗ Invalid Address: ${targetAddress}`));
        console.error("  Address MUST include the protocol mode prefix.");
        console.error("  Example: ANP/C.amazon.anp\n");
        process.exit(1);
    }

    const core = getClinchCore(cfg);
    let runAuto = opts.auto;
    
    if (runAuto === undefined) {
      const autoInput = await prompt("\n👉 Let Agent Q negotiate autonomously? (Y/n): ");
      runAuto = autoInput.toLowerCase() !== 'n';
    }

    if (runAuto) {
      console.log(c.yellow('🤖 Auto-mode: Local LLM sandbox active.\n'));
      await core.sandbox({ modelPath: cfg.modelPath });
    } else {
      await core.initialize(cfg.token);
    }

    core.on('session_started', ({ sessionId }) => {
      console.log(c.green(`\n✓ Session started: ${c.bold(sessionId)}`));
      saveSessionState(sessionId, core); // Initial save
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
    if (ids.length === 0) return console.log(c.yellow('No saved sessions found.'));
    
    console.log(c.bold(`Found ${ids.length} session(s):\n`));
    ids.forEach(id => {
      const s = JSON.parse(sessions[id].state);
      console.log(`  ${c.cyan(id)} - Target: ${s.sellerId} | Status: ${c.bold(s.status)} | Turn: ${s.currentTurn}`);
    });
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

program
  .name('clinch')
  .description('Clinch Protocol — Agent Negotiation CLI')
  .version('0.2.0');

program.parse();
