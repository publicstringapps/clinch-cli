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
const DEALS_FILE  = path.join(CONFIG_DIR, 'deals.json');

// ── Config helpers ────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return [];
  return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
}

function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
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
  try {
    ClinchCoreModule = require('clinch-core');
  } catch {
    console.error('clinch-core not found. Ensure it is linked or installed.');
    process.exit(1);
  }
  const { ClinchCore } = ClinchCoreModule;
  const core = new ClinchCore({ registryUrl: cfg.registryUrl });

  core.on('log', msg => console.log(msg));
  core.on('error', err => console.error('Error:', err.message));
  core.on('status_changed', s => process.stdout.write(`\r[${s}]          \r`));

  return core;
}

// ── Prompt helper ─────────────────────────────────────────────
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
  try {
    nodeLlama = await import('node-llama-cpp');
  } catch (e) {
    console.error(c.red("\nError: node-llama-cpp is required for conversational parsing."));
    console.error("Please run: npm install -g node-llama-cpp\n");
    process.exit(1);
  }

  const resolvedPath = path.resolve(modelPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(c.red(`\nError: Model not found at ${resolvedPath}`));
    console.error("Please run 'clinch init' again or specify the model path.\n");
    process.exit(1);
  }

  const llama = await nodeLlama.getLlama();
  const model = await llama.loadModel({ modelPath: resolvedPath });
  const context = await model.createContext({
    contextSize: 2048,
    threads: Math.max(1, os.cpus().length - 1)
  });

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
  await session.prompt(userInput, {
    maxTokens: 1500,
    onTextChunk: (chunk) => { responseText += chunk; }
  });

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
      if (overwrite.toLowerCase() !== 'y') {
        console.log('Aborted.'); return;
      }
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
    });
  });

program
  .command('negotiate')
  .description('Start a negotiation with a seller agent')
  .argument('[address]', 'Seller address (optional, triggers wizard if omitted)')
  .option('--budget <n>', 'Max budget (USD)')
  .option('--auto', 'Run sandbox auto-negotiation')
  .action(async (address, opts) => {
    const cfg = requireConfig();
    let targetAddress = address;
    let budget = opts.budget;
    let constraints = {};

    // ── WIZARD MODE: Leverage CLI-layer Agent Q ──
    if (!targetAddress || !budget) {
      banner();
      console.log(c.bold("💬 Clinch Onboarding Wizard — Tell me what you're looking for.\n"));

      const naturalIntent = await prompt("👉 Describe what you want to negotiate\n" +
        c.dim("   (e.g., 'Get me the domain cartpost.shop under 80 dollars, must have WHOIS privacy')\n\n💬: "));

      if (!naturalIntent) process.exit(1);

      const parsed = await parseIntentWithLLM(naturalIntent, cfg.modelPath);
      
      if (!parsed) {
        console.error(c.red("✗ Error parsing constraints. Please try manual entry."));
        process.exit(1);
      }

      console.log(c.bold("\n📊 Extracted Intention Context:"));
      console.log(`  - Category:   ${c.cyan(parsed.category)}`);
      console.log(`  - Target Item: ${c.cyan(parsed.item)}`);
      console.log(`  - Max Budget:  ${c.green("$" + parsed.max_budget)}`);
      console.log(`  - Must Haves:  ${c.yellow(parsed.must_haves.join(', ') || 'none')}\n`);

      const confirm = await prompt("👉 Is this correct? (Y/n): ");
      if (confirm.toLowerCase() === 'n') process.exit(0);

      constraints = parsed;
      budget = parsed.max_budget;

      // ── Seller Discovery ──
      console.log(c.dim(`\nQuerying registry to find compatible sellers for "${parsed.category}"...`));
      const coreDiscovery = getClinchCore(cfg);
      await coreDiscovery.initialize(cfg.token);
      const results = await coreDiscovery.search(parsed.category);
      coreDiscovery.disconnect();

      const sellers = results.results || [];
      if (sellers.length === 0) {
        console.log(c.yellow(`\nNo certified sellers found on the network for category "${parsed.category}".`));
        targetAddress = await prompt("👉 Please enter a seller address manually (e.g. amazon.anp): ");
      } else {
        console.log(c.bold(`\nAvailable certified sellers on the network:`));
        sellers.forEach((s, idx) => console.log(`  ${idx + 1}. ${c.cyan(s.agent_id)} (${s.display_name})`));
        const selection = await prompt(`\n👉 Select a seller to target (1-${sellers.length}): `);
        targetAddress = `ANP/A.${sellers[parseInt(selection) - 1].agent_id}`;
      }
    } else {
      constraints = { intent: 'purchase', item: 'Item', max_budget: parseFloat(budget) };
    }

    // ── INITIATE CORE PROTOCOL NEGOTIATION ──
    console.log(c.cyan(`\nStarting negotiation with ${c.bold(targetAddress)}...`));
    const core = getClinchCore(cfg);

    let runAuto = opts.auto;
    if (runAuto === undefined) {
      const autoInput = await prompt("\n👉 Let Agent Q negotiate autonomously? (Y/n): ");
      runAuto = autoInput.toLowerCase() !== 'n';
    }

    if (runAuto) {
      console.log(c.yellow('🤖 Auto-mode: Local LLM sandbox is taking the wheel...\n'));
      await core.sandbox({ modelPath: cfg.modelPath });
    } else {
      await core.initialize(cfg.token);
    }

    core.on('session_started', ({ sessionId }) => {
      console.log(c.green(`\n✓ Session started: ${c.bold(sessionId)}`));
    });

    core.on('status_changed', status => {
      if (status === 'CONVERGED') console.log(c.green(`\n✓ DEAL REACHED at $${core.lastKnownPrice}`));
      if (status === 'STALEMATE') console.log(c.red('\n✗ No deal reached (stalemate)'));
    });

    const sessionId = await core.negotiate(targetAddress, constraints);

    if (!runAuto) {
      console.log(c.bold('\nManual mode — type a price to counter, or "exit" / "accept":\n'));
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.on('line', async (cmd) => {
        if (cmd === 'exit') { await core.exitSession(sessionId); process.exit(0); }
        else if (cmd === 'accept') { console.log(c.green(`Accepting...`)); rl.close(); }
        else {
          const price = parseFloat(cmd);
          if (!isNaN(price)) await core.sendCounter(sessionId, price, 'Counter offer');
        }
      });
    }
  });

program
  .name('clinch')
  .description('Clinch Protocol — Agent Negotiation CLI')
  .version('0.1.0');

program.parse();
