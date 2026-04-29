# Operations Guide

## Configuration

Path: `%USERPROFILE%\.openclaw-codex\config.json` (override with `OPENCLAW_CODEX_CONFIG` env var).

```json
{
  "telegram": {
    "botToken": "<from @BotFather>",
    "ownerUserId": 0,
    "allowedGroupIds": [],
    "streamThrottleMs": 1500,
    "maxQueuePerChat": 3
  },
  "codex": {
    "binary": "C:\\Users\\<you>\\AppData\\Roaming\\npm\\codex.cmd",
    "workspaceDir": "C:\\path\\to\\agent\\workspace",
    "sandbox": "workspace-write",
    "approval": "never",
    "execTimeoutMs": 300000
  },
  "sessions": {
    "storePath": "%USERPROFILE%\\.openclaw-codex\\sessions.json"
  },
  "logging": {
    "dir": "C:\\tmp\\openclaw-codex"
  },
  "proxy": {
    "https_proxy": null,
    "no_proxy": "127.0.0.1,localhost,::1,api.telegram.org"
  }
}
```

`codex.binary` should be the absolute path to `codex.cmd` on Windows (resolves around CVE-2024-27980 which blocks Node from spawning .cmd via PATH lookup). On Linux/macOS, `"codex"` is fine.

`codex.workspaceDir` should contain an `AGENTS.md` so Codex knows the agent's identity. Codex auto-loads `AGENTS.md` per the [agents.md](https://agents.md/) convention.

`sandbox` and `approval` are kept in the config for forward compatibility but **are not currently passed to Codex 0.125** — instead the bridge always passes `--full-auto` (workspace-write + no approval prompts).

## Telegram commands

| Command | Behavior |
|---|---|
| `/start`   | Show command list. |
| `/reset`   | Drop the session for this chat — next message starts fresh. |
| `/status`  | Print uptime, current session id, queue depth, last error. |
| `/whoami`  | Brief self-introduction. |

Photos are handled automatically: the largest variant is downloaded to `%TEMP%\openclaw-codex-images\` and passed to codex via `-i`. Caption (if any) becomes the prompt; otherwise `«Что на изображении? Опиши кратко.»`.

## Run modes

### Foreground (development)

```cmd
npm start
```

### Background as Windows Scheduled Task

`scripts\gateway-hidden.vbs` is a hidden-window auto-restart wrapper. `scripts\watchdog.vbs` polls every 5min and kicks the bridge if it stops. Register both:

```cmd
schtasks /Create /TN "OpenClaw-Codex Bridge" ^
  /TR "wscript.exe \"C:\path\to\scripts\gateway-hidden.vbs\"" ^
  /SC ONLOGON /RU %USERDOMAIN%\%USERNAME% /RL HIGHEST /F

schtasks /Create /TN "OpenClaw-Codex Watchdog" ^
  /TR "wscript.exe \"C:\path\to\scripts\watchdog.vbs\"" ^
  /SC ONLOGON /RU %USERDOMAIN%\%USERNAME% /RL HIGHEST /F

schtasks /Run /TN "OpenClaw-Codex Bridge"
schtasks /Run /TN "OpenClaw-Codex Watchdog"
```

Recommended: set the Bridge task's `MultipleInstancesPolicy` to `IgnoreNew` so concurrent /Run calls don't double-launch.

## Logs

- `C:\tmp\openclaw-codex\YYYY-MM-DD.log` — daily-rotated NDJSON from the bridge process
- `C:\tmp\openclaw-codex\restart.log` — `gateway-hidden.vbs` restart events
- `C:\tmp\openclaw-codex\watchdog.log` — watchdog kick events

## Migration from clawdbot (openclaw)

If you're replacing an existing `clawdbot` install:

1. Stop and disable the Scheduled Tasks `Clawdbot Gateway` and `Clawdbot Watchdog` (the bot token can only be owned by one polling consumer).
2. Re-use the existing `clawd\` workspace as `codex.workspaceDir` to inherit memory, identity, scripts, and knowledge bases without copy.
3. Prepend a Codex-friendly identity section to `AGENTS.md` (the rest of the openclaw `AGENTS.md` content remains valid as reference).
4. Optionally port `~/.clawdbot/cron/jobs.json` entries to Windows Scheduled Tasks via [`scripts/port-cron.ps1`](../scripts/port-cron.ps1) — generates one Scheduled Task per enabled cron job, with a wrapper `.cmd` that tells codex to read a prompt file.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Bot does not reply | Old clawdbot still polling — `schtasks /End /TN "Clawdbot Gateway"` |
| `codex login` fails | OpenAI blocked from your network — set `HTTPS_PROXY` or use a VPN/Proxifier |
| `spawn EINVAL` | Node 18.20+ blocks `.cmd` spawn; bridge handles it via `shell:true` + absolute path. Make sure `codex.binary` in config is an absolute path. |
| `'codex.cmd' is not recognized` | npm global bin not on the spawned process PATH; set `codex.binary` to absolute path |
| `(пустой ответ)` | Codex exited cleanly without emitting an `agent_message` item — usually means the model returned tool calls only. Check the bridge log for the raw events. |
| `unexpected argument '--ask-for-approval'` | Codex 0.125 dropped the flag; bridge uses `--full-auto` instead. Update if you see this. |
| `unexpected argument '--cd'` on resume | `codex exec resume` does not accept `--cd`; bridge omits it on resume. |
| Identity wrong (says «I am Codex») | `AGENTS.md` missing identity section — add the «You are X» block at the top |
| Long replies truncated | Telegram caps message text at 4096 chars — bridge truncates at 4000 |
| Codex exit non-zero, error mentions auth | OAuth token expired (`codex login` again) or rate-limited (wait or upgrade plan) |
