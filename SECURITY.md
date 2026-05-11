# Security model

`claude-remote-free` is built for **single-user, single-tenant** remote access. It is not a multi-user terminal-sharing service. Read this whole document before exposing the daemon to anything beyond `localhost`.

## Threat model

| Adversary | In scope | Out of scope |
|---|---|---|
| Someone on the open internet without your login token | Yes | — |
| Someone on the open internet with your login token | — | Yes (treat the token like an SSH key) |
| A malicious browser tab on a host that has the auth cookie | Partial: SameSite + Origin checks prevent obvious CSRF | A compromised endpoint can do whatever Claude can do |
| A local user on the same machine | — | The daemon's socket files are `0600`; anything beyond that requires OS-level isolation |
| Your provider proxying Claude requests | — | Whatever they log they log; this tool doesn't change that |

## What the daemon enforces

- **Bind**: `127.0.0.1` by default. Changing it to `0.0.0.0` triggers a startup warning. The intended deployment is "bind localhost, layer a tunnel on top."
- **Login**: 32-byte random token (base64url), stored at `~/.config/claude-remote-free/config.json` with mode `0600`. POST to `/login`; on success the server issues an HMAC-signed session cookie (`HttpOnly`, `SameSite=Strict`, and `Secure` if started with `--behind-https`).
- **No URL tokens**: tokens never appear in URLs, query strings, referers, or logs.
- **Rate limit**: 5 failed login attempts per IP per 5 minutes (in-memory bucket; resets on daemon restart).
- **WebSocket gating**: every `/ws` upgrade is checked for (a) a valid session cookie and (b) an `Origin` header in the allow-list (defaults to the bind URL; `--tunnel cloudflare` adds the `trycloudflare.com` URL automatically).
- **Per-message protocol**: WebSocket frames are length+type prefixed binary; control frames are JSON. There is no JSON parser on hot path bytes from the PTY.

## What the daemon does **not** enforce

- **TLS**: the daemon speaks plain HTTP. TLS must come from the tunnel or reverse proxy in front of it. Do not expose the daemon directly to the public internet.
- **Per-action authorization**: anyone who logs in gets a full PTY into `claude`, which can run `Bash`, edit files, etc. **The login token is equivalent to shell access on your machine.**
- **Sandboxing**: `claude` runs as the same user as the daemon. There is no chroot, no syscall filter, no capability dropping.
- **Forensic logging**: the daemon does not record terminal contents or commands. The PTY runs in your shell as you, leaving the usual traces.

## Recommended deployment

1. **Tailscale** (preferred): install Tailscale, run the daemon bound to `127.0.0.1`, access via your tailnet. mTLS via WireGuard; the daemon is never reachable from the public internet.
2. **Cloudflare Tunnel** (if you need a public URL): run `cloudflared` either via `--tunnel cloudflare` (quick, ephemeral subdomain) or a named tunnel (stable subdomain, requires DNS setup). Add Cloudflare Access on top if you want SSO-gated entry without sharing the token.
3. **Self-hosted reverse proxy with HTTPS** (nginx/Caddy): terminate TLS, proxy to `127.0.0.1:7878`, forward WebSocket upgrade headers, and start the daemon with `--behind-https`. Make sure your proxy doesn't leak `Origin` or `Cookie` in logs.

## Token rotation

Delete the `token` field from `~/.config/claude-remote-free/config.json` (or delete the whole file) and restart the daemon. A new token is generated on next start. All existing sessions are invalidated implicitly because the daemon also re-rolls its session-signing secret on every start.

## Reporting

Open an issue at the repo with details. If a vulnerability is sensitive, mark the issue private (or contact the maintainer through GitHub).
