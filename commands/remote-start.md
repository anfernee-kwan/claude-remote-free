---
description: Start the claude-remote-free daemon so you can reach Claude Code from a browser.
allowed-tools: Bash(claude-remote-free start*), Bash(node bin/claude-remote-free.js start*)
---

Start the remote-browser daemon for the current machine.

By default this runs the daemon detached, with a brand-new `claude` session inside it (so the session in your browser is **NOT** the one this slash command is being executed in — the OS does not allow a sibling process to take over your CLI's tty).

If the user wants the browser to mirror the *current* local session, point them at one of these instead:
- `tmux new -s claude` then run `claude` inside it, then `/remote-start` with `--tmux claude`
- Or run `claude-remote-free attach -- claude` in another terminal first, then `/remote-start` with `--source wrapper`

Default invocation:

```bash
claude-remote-free start --detach
```

If the user installed from source without `npm link`, fall back to:

```bash
node /path/to/claude-remote-free/bin/claude-remote-free.js start --detach
```

(Once the package is published to npm, `npx -y claude-remote-free start --detach` will also work.)

After it starts, print:
- the URL it's listening on (default http://127.0.0.1:7878)
- the login token (from the daemon's first-run output or `~/.config/claude-remote-free/config.json`)
- a reminder that the daemon is **not encrypted on its own** — production access should go through Tailscale or a Cloudflare Tunnel (`--tunnel cloudflare` for a quick public URL)
