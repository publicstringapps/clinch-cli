# Agent Clinch (`agent-clinch`)

> **Agent Negotiation Protocol — Terminal Client & Autonomous Agent Q**

The Clinch CLI is the official reference implementation of a Clinch Protocol buyer agent. It allows you to discover sellers, negotiate deals interactively, or dispatch an autonomous local AI agent using "Agent Q" (agent query) to haggle on your behalf—right from your terminal.

By keeping the execution edge-first, all cryptographic keys, session transcripts, downloaded models, and dynamic session states are stored strictly on your local machine. With robust state serialization, you can even close your terminal and resume dropped or asynchronous negotiations later.

---

## 📦 Installation

Install the CLI globally via NPM:

```bash
npm install -g agent-clinch
```

*Note: To use the conversational wizard or the `--auto` flag (which allows the local LLM to parse your intent and negotiate autonomously), you must have `node-llama-cpp` installed globally or in your environment:*
```bash
npm install -g node-llama-cpp
```

---

## 🚀 Getting Started

### 1. Initialize your Agent
Before you can negotiate, you need to generate your cryptographic identity and register with the network via Proof-of-Work (PoW).

```bash
clinch init
```
This command:
1. Generates a permanent Ed25519 identity keypair.
2. Solves the network PoW challenge (taking ~1-2 seconds of CPU).
3. Retrieves a long-lived JWT access token.
4. Saves your configuration to `~/.clinch/config.json`.

### 2. The Conversational Wizard (Agent Q)
The easiest way to use Clinch is to simply type:

```bash
clinch negotiate
```

Instead of memorizing flags and routing prefixes, the CLI boots a local LLM to ask what you want in plain English.

```text
💬 Clinch Onboarding Wizard — Tell me what you're looking for.

👉 Describe what you want to negotiate
   (e.g., 'Get me the domain cartpost.shop under 80 dollars, must have WHOIS privacy')

💬: I need a high-speed blender under 100 dollars, make sure it has a warranty and fast shipping

[Agent Q] Booting local parser model to analyze your request...

📊 Extracted Intention Context:
  - Category:   kitchen_appliance
  - Target Item: high-speed blender
  - Max Budget:  $100
  - Must Haves:  warranty, fast shipping
```

Agent Q parses your natural language into a strict JSON constraint vector, queries the Clinch Registry to find matching sellers, and lets you select your target. It then seamlessly transitions into the negotiation phase.

### 3. Explicit Negotiation (Manual or Auto Mode)
If you already know the seller's address and want to bypass the wizard, you can pass arguments directly. **Note: Clinch Protocol requires strict routing prefixes (e.g., `ANP/C.`) on all addresses.**

**Manual Mode:** Open an interactive terminal where you manually input counter-offers.
```bash
clinch negotiate ANP/C.amazon.anp --budget 85.00
```
*   Type a number (e.g., `45.50`) to send a counter-offer.
*   Type `accept` to seal the deal.
*   Type `exit` to terminate and issue a callback token to the seller.

**Auto Mode:** Add the `--auto` flag to hand control over to the local LLM Sandbox (Qwen 2.5 1.5B). The agent will evaluate the seller's offers and negotiate autonomously up to your strict max budget.
```bash
clinch negotiate ANP/C.cloudflare.anp --budget 50.00 --auto
```

### 4. Resuming Asynchronous Sessions
If you exit a negotiation before it concludes, or a seller places your offer in an asynchronous callback queue, the CLI automatically saves your exact session state and cryptographic session keys to disk.

List your saved sessions:
```bash
clinch sessions
```

Resume a specific session and listen for webhooks/callbacks:
```bash
clinch resume <sessionId> --auto
```

---

## 🛠 Command Reference

### `clinch init [options]`
Initializes the agent and performs network registration.
*   `--registry <url>`: Override the default dynamic registry configuration (Useful for local testing).
*   `--model <path>`: Specify a custom path for the `.gguf` model file.

### `clinch query <category> [options]`
Queries the registry for seller nodes.
*   `--mode <mode>`: Filter by agent protocol mode (e.g., `ANP/C`).

### `clinch negotiate [address] [options]`
Opens a session with a target seller address. If `address` or `--budget` are omitted, launches the conversational wizard. 
*   `[address]`: The target seller address MUST include the protocol prefix (e.g., `ANP/C.seller_domain`).
*   `--budget <n>`: Your absolute maximum budget in USD.
*   `--auto`: Delegates turn-based negotiation to the local AI sandbox.

### `clinch sessions`
Lists all historical and active negotiation sessions stored on your machine, displaying the session ID, target seller, current turn, and status.

### `clinch resume <sessionId> [options]`
Rehydrates a specific session's state and cryptographic keys into memory to continue negotiating or wait for remote seller callbacks.
*   `--auto`: Immediately hands the resumed session back to the local AI sandbox to evaluate incoming callbacks.

---

## 📂 Local Storage & Privacy

The Clinch CLI operates on a strict zero-trust, edge-first model. Your data never leaves your machine unless explicitly sent as a constraint during a session.

All state is stored locally in your home directory (`~/.clinch/`):
*   `config.json`: Your identity keys, Registry authorization token, and preferences. **Do not share this file.**
*   `sessions.json`: Local transcripts, current turns, constraint vectors, and the ephemeral Ed25519 session keys necessary to prove your identity during resumed negotiations.
*   `deals.json`: Placeholder for cryptographically signed deal artifacts (Implementation upcoming).
