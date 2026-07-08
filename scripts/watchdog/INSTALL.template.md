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

Wire hooks in `~/.claude/settings.json`:

- `SessionStart` -> `start-watchdog.sh`
- `PostToolUse` -> `heartbeat.sh`
- `Stop` -> `stop-watchdog.sh`
- `SessionEnd` -> `stop-watchdog.sh`

Recommended variables:

| Variable | Default | Meaning |
|---|---|---|
| `WATCHDOG_INTERVAL` | `30` | heartbeat check interval |
| `WATCHDOG_THRESHOLD` | `600` | stale seconds before alert |
| `WATCHDOG_MAX_LIFETIME` | `43200` | orphan defense max runtime |

