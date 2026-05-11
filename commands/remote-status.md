---
description: Show whether the claude-remote-free daemon is running and how to reach it.
allowed-tools: Bash(npx claude-remote-free status), Bash(claude-remote-free status)
---

Report the status of the remote-browser daemon.

```bash
npx -y claude-remote-free status
```

Output includes:
- daemon state (running / stale pidfile / not running)
- config file location (so the user can find the login token)
- URL the daemon is bound to
- whether the port is currently reachable
