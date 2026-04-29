# openclaw-codex

Telegram → OpenAI Codex CLI bridge. Chat with a personal AI assistant in Telegram backed by your **ChatGPT Plus/Pro subscription** instead of pay-per-token API fees.

## What it does

- Receives messages on a Telegram bot (long polling via [grammy](https://grammy.dev)).
- Spawns `codex exec --json` for each turn, piping the user prompt via stdin and resuming the per-chat session.
- Edits a placeholder Telegram message with the agent's reply when the turn completes.
- Persists `chat_id → session_id` mappings in a JSON file for conversation continuity (`codex exec resume <id>`).
- Handles photo messages: downloads to a temp dir and passes via codex `-i <file>`.

## Why

- ChatGPT subscription is a flat fee; the OpenAI/Anthropic APIs charge per token.
- Codex CLI is the only legitimate way to use the ChatGPT subscription programmatically — you OAuth your account once and the CLI uses it for all requests.

## Requirements

- Windows 10+ / Server 2019+ (the service install uses VBS + Scheduled Tasks; Linux/macOS work for the bridge itself but autostart is not provided)
- Node.js 20+
- `@openai/codex` CLI installed and authenticated (`codex login`)
- A Telegram bot token (`@BotFather`)

## Install

```cmd
git clone https://github.com/djdes/openclaw-codex.git
cd openclaw-codex
npm install
npm install -g @openai/codex
codex login
```

Then create `%USERPROFILE%\.openclaw-codex\config.json` (see [docs/operations.md](docs/operations.md) for schema) and:

```cmd
npm start
```

## Architecture

```
Telegram ←→ grammy bot ←→ per-chat queue ←→ codex exec --json ←→ AGENTS.md workspace
                              │
                              └→ session-store.json (chat_id → session_id)
```

See [docs/operations.md](docs/operations.md) for full operations, autostart on Windows, photo handling, cron migration from clawdbot, and troubleshooting.

## License

MIT — see [LICENSE](LICENSE).
