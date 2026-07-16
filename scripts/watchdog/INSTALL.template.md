# Watchdog Install Template

The scripts in this folder were copied from the source team workspace to preserve unattended
hang detection. Replace `{{AI_TEAM_PATH}}` before installing.

## Hook-Spawned Watchdog

```bash
mkdir -p ~/.claude/scripts
cp {{AI_TEAM_PATH}}/scripts/watchdog/heartbeat.sh ~/.claude/scripts/
cp {{AI_TEAM_PATH}}/scripts/watchdog/start-watchdog.sh ~/.claude/scripts/
cp {{AI_TEAM_PATH}}/scripts/watchdog/watchdog-loop.sh ~/.claude/scripts/
cp {{AI_TEAM_PATH}}/scripts/watchdog/stop-watchdog.sh ~/.claude/scripts/
chmod +x ~/.claude/scripts/*.sh
```

Wire hooks in `~/.claude/settings.json` (session-level model):

- `SessionStart` -> `start-watchdog.sh`
- `PostToolUse` -> `heartbeat.sh`
- `SessionEnd` -> `stop-watchdog.sh`

Do NOT wire `stop-watchdog.sh` to the `Stop` hook: per the official Hooks
semantics, `Stop` fires every time the main agent finishes a RESPONSE — not
when the session ends — so a Stop-wired stop kills the watchdog after the
first turn and nothing restarts it (`SessionStart` will not fire again in the
same session). The whole point of the watchdog is to monitor between turns of
a long session; only `SessionEnd` may stop it.

The loop tolerates the alert state: after a stale alert it keeps waiting (the
heartbeat file is set aside as `.alerted-<ts>`), and monitoring resumes
automatically when the next tool result recreates the heartbeat.

Recommended variables:

| Variable | Default | Meaning |
|---|---|---|
| `WATCHDOG_INTERVAL` | `30` | heartbeat check interval |
| `WATCHDOG_THRESHOLD` | `600` | stale seconds before alert |
| `WATCHDOG_MAX_LIFETIME` | `43200` | orphan defense max runtime |

