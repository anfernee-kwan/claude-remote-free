---
description: Show whether the claude-remote-free daemon is running and how to reach it.
allowed-tools: Bash(claude-remote-free status), Bash(node bin/claude-remote-free.js status)
---

Report the status of the remote-browser daemon.

```bash
claude-remote-free status
```

(Source-install fallback: `node /path/to/claude-remote-free/bin/claude-remote-free.js status`. Once the package is on npm, `npx -y claude-remote-free status` will also work.)

Output includes:
- daemon state (running / stale pidfile / not running)
- config file location (so the user can find the login token)
- URL the daemon is bound to
- whether the port is currently reachable
