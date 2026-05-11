# claude-remote-free

Remote browser access to your local Claude Code CLI session. Self-hosted, single-user, provider-agnostic. Also packaged as a Claude Code plugin.

Use case: you run `claude` on your home/work machine. You want to drive it from your phone or another machine, without an Anthropic web account, and without giving anyone a public exposed port.

## How it works

`claude-remote-free` starts a small Node daemon on `127.0.0.1` that:

1. Spawns or attaches to a PTY running `claude` (or any program, see "wrapper mode" below)
2. Serves a single HTML page with [xterm.js](https://xtermjs.org) on it
3. Pipes the PTY to/from the browser over a WebSocket

External access is provided by **a tunnel of your choice** (Tailscale, Cloudflare Tunnel, frp). The daemon does no TLS termination on its own — that is the tunnel's job. See `SECURITY.md`.

## Install from source

This project is **not yet published to npm**, and `npm install -g github:<owner>/claude-remote-free` is known to mis-run `node-pty`'s postinstall in global mode. The reliable install path is:

```bash
git clone https://github.com/anfernee-kwan/claude-remote-free.git
cd claude-remote-free
npm install
npm run build
# now use either of:
node bin/claude-remote-free.js start
npm link        # exposes `claude-remote-free` on your PATH
```

### Supported Node versions

- **Node 20 LTS, 22 LTS, 24 Current**: prebuilt `node-pty` binaries work out of the box.
- **Node 25+**: `node-pty@1.1.0`'s prebuilt `.node` files were compiled against older Node ABIs. The native module will load but call `forkpty(3)` with a layout the new ABI doesn't honor, surfacing as `posix_spawnp failed` once the daemon starts. Rebuild from source after `npm install`:

  ```bash
  npm run rebuild-pty   # delegates to: cd node_modules/node-pty && npx node-gyp rebuild
  ```

  You'll need a working C/C++ toolchain (`xcode-select --install` on macOS; `build-essential` + `python3` on Debian/Ubuntu).

If you don't know which case you fall into, run `node --version`. Anything `<25` should "just work"; `>=25` needs the rebuild step.

## Quick start

After installing from source, from the repo root:

```bash
# foreground, fresh claude session, http://127.0.0.1:7878
node bin/claude-remote-free.js start

# detach into background, also start a Cloudflare quick tunnel for public access
node bin/claude-remote-free.js start --detach --tunnel cloudflare
```

(`npx claude-remote-free ...` will work the day this lands on npm; until then, use the source path or `npm link` it onto your PATH.)

The first run writes a config file at `~/.config/claude-remote-free/config.json` containing a 32-byte random login token. The token is printed to stdout the first time the daemon starts. Open the URL it prints, paste the token, and you're in.

To stop:

```bash
node bin/claude-remote-free.js stop
```

## As a Claude Code plugin

Install once:

```bash
# from inside another claude session
/plugin install <this repo>
```

Then from any `claude` session:

- `/remote-start` — start the daemon (default: detached, fresh session)
- `/remote-status` — show URL, PID, source mode
- `/remote-stop` — kill the daemon

Note: a `/remote-start`-spawned daemon runs an **independent** `claude` session, not the one you typed the slash command from. The OS does not let one process steal another's tty. See "Three session sources" below for how to share a session.

## Three session sources

| `--source` | Behavior | Best for |
|---|---|---|
| `fresh` (default) | Daemon spawns a brand-new `claude` process | Quick remote access to a clean session |
| `tmux` (`--tmux <name>`) | Daemon runs `tmux attach-session -t <name>`; tmux fans out to all attached clients | Mirroring your local session — you start `claude` inside a tmux session and your browser sees the same thing as your local tmux |
| `wrapper` | Daemon connects to a unix socket exposed by `claude-remote-free attach -- claude` | Same as tmux but without needing tmux installed |

### tmux mode

```bash
# in terminal 1
tmux new -s claude
claude  # use it normally

# in terminal 2
claude-remote-free start --tmux claude --detach

# open the browser; what you see is the same tmux session as terminal 1
```

### wrapper mode

```bash
# in terminal 1: replaces 'claude' as your launch command
claude-remote-free attach -- claude
# use claude normally; this terminal also exposes a unix socket

# in terminal 2
claude-remote-free start --source wrapper --detach

# the browser mirrors what terminal 1 sees, including everything typed in either place
```

## Provider configuration (out of scope for the daemon)

`claude-remote-free` does **not** parse, store, or expose your provider credentials. It spawns `claude` with the daemon's process environment forwarded verbatim. To use a non-Anthropic provider, just export the right environment variables before starting the daemon — exactly the same vars that `claude` honors when you run it directly.

### Anthropic (default)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
claude-remote-free start --detach
```

### Any OpenAI-compatible proxy (OpenRouter, DeepSeek, GLM, custom router)

The Claude CLI translates Anthropic-format requests to whatever lives at `ANTHROPIC_BASE_URL`. Use this for any third-party that ships an Anthropic-compatible endpoint, or sit behind a proxy like `claude-code-router` for general OpenAI-style providers.

```bash
export ANTHROPIC_BASE_URL=https://your-proxy.example.com
export ANTHROPIC_AUTH_TOKEN=...           # whatever your proxy expects
export ANTHROPIC_MODEL=...                 # optional model override
claude-remote-free start --detach
```

### Amazon Bedrock

```bash
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=us-west-2
# plus your usual AWS credential chain (env, profile, IAM role)
claude-remote-free start --detach
```

### Google Vertex AI

```bash
export CLAUDE_CODE_USE_VERTEX=1
export CLOUD_ML_REGION=us-east5
export ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project
# plus standard gcloud auth (ADC, service account, etc.)
claude-remote-free start --detach
```

Verify env passthrough at any time:

```bash
ANTHROPIC_BASE_URL=https://example.invalid claude-remote-free start
# open the browser; `claude` should complain about "cannot reach example.invalid"
```

## Tunnels

The daemon binds to `127.0.0.1` by default and refuses to do TLS itself. For remote access, layer a tunnel on top:

### Tailscale (recommended — zero exposure)

1. Install Tailscale on the host and the device you want to access from.
2. `claude-remote-free start --detach`
3. From your phone on Tailscale: `http://<tailnet-machine-name>:7878`

No public exposure, mTLS end-to-end via Tailscale's WireGuard mesh.

### Cloudflare Tunnel (public URL with HTTPS)

If `cloudflared` is installed:

```bash
claude-remote-free start --detach --tunnel cloudflare
# look in daemon logs for a trycloudflare.com URL
```

`--tunnel cloudflare` spawns `cloudflared tunnel --url http://127.0.0.1:<port>`, scrapes the public URL, and adds it to the WebSocket origin whitelist automatically. Logs at `~/.local/state/claude-remote-free/daemon.log`.

For a stable subdomain, run your own named Cloudflare tunnel pointing at `127.0.0.1:7878` instead of using `--tunnel cloudflare`.

### frp / nginx / Caddy

Treat the daemon like any other plain-HTTP service. Make sure your reverse proxy forwards WebSocket upgrade headers. If terminated outside the daemon, start it with `--behind-https` so the auth cookie gets the `Secure` flag.

## CLI reference

```
claude-remote-free start [options]
  --detach              Run in background; logs go to ~/.local/state/claude-remote-free/daemon.log
  --source <kind>       fresh (default) | wrapper | tmux
  --tmux <session>      Shortcut for --source tmux <session>
  --port <n>            Override config port (default 7878)
  --bind <addr>         Override bind address (default 127.0.0.1)
  --behind-https        Mark the login cookie Secure (use when fronted by HTTPS)
  --tunnel cloudflare   Also start a `cloudflared` quick tunnel

claude-remote-free stop
claude-remote-free status
claude-remote-free attach -- <cmd> [args...]
```

## Files

- `~/.config/claude-remote-free/config.json` — port, bind, token, allowed origins
- `~/.local/state/claude-remote-free/daemon.pid`
- `~/.local/state/claude-remote-free/daemon.log`
- `~/.local/state/claude-remote-free/attach.sock` (wrapper mode only)

## Troubleshooting

### `posix_spawnp failed` on Node 25+ (macOS arm64 and others)

Symptom: the daemon prints `posix_spawnp failed` repeatedly as soon as it tries to spawn `claude`.

Cause: `node-pty@1.1.0` ships prebuilt `.node` binaries (`node_modules/node-pty/prebuilds/<platform>/pty.node`) compiled against the ABI of older Node releases. Node 25 loads them but the native call shape no longer matches. The library's README explicitly notes that supported Node versions "mostly track whatever VS Code uses," so non-LTS Current releases lag.

Fix:

```bash
npm run rebuild-pty
```

That delegates to `cd node_modules/node-pty && npx node-gyp rebuild` and produces a fresh `build/Release/pty.node` against the running Node. Requires a working C/C++ toolchain.

Long-term: upgrade `node-pty` once a stable release with refreshed prebuilds for Node 25 ships, or pin Node to 20/22/24 LTS for production hosts.

### `npm install -g github:<owner>/claude-remote-free` doesn't work

Known issue with native-module postinstall in global installs. Until this repo is published to npm, use the from-source install path above. `npm link` after a local install gives you the same `claude-remote-free` command on your `PATH` without the global postinstall pitfall.

### Cloudflare Quick Tunnel returns 500 intermittently

That's a `trycloudflare.com` service-side issue, not a daemon bug. Retry, or move to a named Cloudflare tunnel or Tailscale.

## License

MIT. See `LICENSE`.
