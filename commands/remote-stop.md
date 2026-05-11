---
description: Stop the claude-remote-free daemon.
allowed-tools: Bash(claude-remote-free stop), Bash(node bin/claude-remote-free.js stop)
---

Stop the remote-browser daemon for the current machine.

```bash
claude-remote-free stop
```

(Source-install fallback: `node /path/to/claude-remote-free/bin/claude-remote-free.js stop`. Once the package is on npm, `npx -y claude-remote-free stop` will also work.)

This reads `~/.local/state/claude-remote-free/daemon.pid` and sends SIGTERM. If the pidfile is stale (process no longer alive), the command cleans it up and reports that the daemon was not running.
