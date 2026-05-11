---
description: Stop the claude-remote-free daemon.
allowed-tools: Bash(npx claude-remote-free stop), Bash(claude-remote-free stop)
---

Stop the remote-browser daemon for the current machine.

```bash
npx -y claude-remote-free stop
```

This reads `~/.local/state/claude-remote-free/daemon.pid` and sends SIGTERM. If the pidfile is stale (process no longer alive), the command cleans it up and reports that the daemon was not running.
