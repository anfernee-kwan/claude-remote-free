import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { loadOrCreateConfig, configFileLocation } from './config';
import { readPidFile, isProcessAlive, removePidFile } from './pidfile';
import { LOG_FILE, STATE_DIR } from './paths';
import { runAttach } from './attach';
import { runDaemon, type DaemonOpts } from './daemon';

const USAGE = `claude-remote-free <command> [options]

Commands:
  start [options]       Start the daemon
    --detach            Run in background (default: foreground)
    --source <kind>     fresh (default) | wrapper | tmux
    --tmux <session>    Shortcut for --source tmux <session>
    --port <n>          Override config port
    --bind <addr>       Override bind address (default 127.0.0.1)
    --behind-https      Mark cookies Secure (use when behind HTTPS proxy/tunnel)
    --tunnel cloudflare Spawn a Cloudflare quick tunnel after start
  stop                  Stop a running daemon (reads pidfile)
  status                Report daemon PID/URL/source
  attach -- <cmd> [...] Run <cmd> in a PTY and expose it on a unix socket
                        for the daemon (--source wrapper) to attach to
`;

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  switch (cmd) {
    case 'start':
      await cmdStart(rest);
      return;
    case 'stop':
      cmdStop();
      return;
    case 'status':
      cmdStatus();
      return;
    case 'attach':
      await cmdAttach(rest);
      return;
    default:
      process.stderr.write(`unknown command: ${cmd}\n${USAGE}`);
      process.exit(2);
  }
}

interface StartFlags {
  detach: boolean;
  source: 'fresh' | 'wrapper' | 'tmux';
  tmux?: string;
  port?: number;
  bind?: string;
  behindHttps: boolean;
  tunnel?: 'cloudflare';
}

function parseStartFlags(args: string[]): StartFlags {
  const out: StartFlags = { detach: false, source: 'fresh', behindHttps: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--detach') out.detach = true;
    else if (a === '--source') {
      const v = args[++i];
      if (v !== 'fresh' && v !== 'wrapper' && v !== 'tmux') {
        throw new Error(`--source must be fresh|wrapper|tmux, got: ${v}`);
      }
      out.source = v;
    } else if (a === '--tmux') {
      out.source = 'tmux';
      out.tmux = args[++i];
      if (!out.tmux) throw new Error('--tmux requires a session name');
    } else if (a === '--port') {
      out.port = Number(args[++i]);
      if (!Number.isFinite(out.port) || out.port <= 0) throw new Error('bad --port');
    } else if (a === '--bind') {
      out.bind = args[++i];
    } else if (a === '--behind-https') {
      out.behindHttps = true;
    } else if (a === '--tunnel') {
      const v = args[++i];
      if (v !== 'cloudflare') throw new Error('--tunnel only supports: cloudflare');
      out.tunnel = v;
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return out;
}

async function cmdStart(args: string[]): Promise<void> {
  const flags = parseStartFlags(args);

  // Sanity check: only one daemon per machine.
  const existing = readPidFile();
  if (existing && isProcessAlive(existing)) {
    process.stderr.write(`daemon already running (pid ${existing}); run 'stop' first\n`);
    process.exit(1);
  }
  if (existing) removePidFile();

  // Touch config to ensure token exists and is logged.
  const cfg = loadOrCreateConfig();
  void cfg;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CRF_SOURCE: flags.source,
    CRF_TMUX: flags.tmux,
    CRF_BEHIND_HTTPS: flags.behindHttps ? '1' : '0',
    CRF_TUNNEL: flags.tunnel,
    CRF_WEB_DIR: resolveWebDir(),
  };
  if (flags.port) env.CRF_PORT = String(flags.port);
  if (flags.bind) env.CRF_BIND = flags.bind;

  const daemonScript = path.resolve(__dirname, 'daemon.js');

  if (!flags.detach) {
    const daemonOpts: DaemonOpts = {
      source: flags.source,
      tmuxSession: flags.tmux,
      port: flags.port,
      bind: flags.bind,
      behindHttps: flags.behindHttps,
      tunnel: flags.tunnel,
      webDir: resolveWebDir(),
    };
    await runDaemon(daemonOpts);
    return;
  }

  // Background: spawn detached child with stdio redirected to LOG_FILE.
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const out = fs.openSync(LOG_FILE, 'a');
  const err = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [daemonScript], {
    env,
    detached: true,
    stdio: ['ignore', out, err],
  });
  child.unref();
  process.stdout.write(`daemon started (pid ${child.pid}); logs: ${LOG_FILE}\n`);

  // Wait briefly for pidfile to appear so 'status' immediately after 'start' works.
  await waitForPidFile(2000);
}

async function waitForPidFile(timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (readPidFile()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function cmdStop(): void {
  const pid = readPidFile();
  if (!pid) {
    process.stdout.write('no daemon pidfile; nothing to stop\n');
    return;
  }
  if (!isProcessAlive(pid)) {
    process.stdout.write(`pid ${pid} is not alive; cleaning up pidfile\n`);
    removePidFile();
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    process.stdout.write(`sent SIGTERM to pid ${pid}\n`);
  } catch (err) {
    process.stderr.write(`failed to signal pid ${pid}: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

function cmdStatus(): void {
  const cfg = loadOrCreateConfig();
  const pid = readPidFile();
  if (!pid) {
    process.stdout.write('daemon: not running\n');
    process.stdout.write(`config: ${configFileLocation()}\n`);
    return;
  }
  const alive = isProcessAlive(pid);
  process.stdout.write(`daemon: ${alive ? 'running' : 'stale pidfile'} (pid ${pid})\n`);
  process.stdout.write(`config: ${configFileLocation()}\n`);
  process.stdout.write(`url:    http://${cfg.bind === '0.0.0.0' ? '<host>' : cfg.bind}:${cfg.port}\n`);

  // Best-effort: actually probe the port.
  if (alive) {
    const sock = net.connect(cfg.port, cfg.bind === '0.0.0.0' ? '127.0.0.1' : cfg.bind);
    sock.setTimeout(500);
    sock.on('connect', () => {
      process.stdout.write(`port:   reachable\n`);
      sock.end();
    });
    sock.on('error', () => {
      process.stdout.write(`port:   not reachable (yet)\n`);
    });
    sock.on('timeout', () => {
      sock.destroy();
    });
  }
}

async function cmdAttach(args: string[]): Promise<void> {
  // `attach -- <cmd> [args...]` or `attach <cmd> [args...]`
  let body = args;
  const sep = args.indexOf('--');
  if (sep >= 0) body = args.slice(sep + 1);
  if (body.length === 0) {
    process.stderr.write('attach requires a command, e.g. claude-remote-free attach -- claude\n');
    process.exit(2);
  }
  const [command, ...rest] = body;
  await runAttach({ command, args: rest });
}

function resolveWebDir(): string {
  // Production: web/dist sits next to the package root (alongside dist/).
  const pkgRoot = path.resolve(__dirname, '..');
  const candidate = path.join(pkgRoot, 'web', 'dist');
  if (fs.existsSync(candidate)) return candidate;
  // Dev fallback: web/src for hand-edited HTML during development
  const src = path.join(pkgRoot, 'web', 'src');
  return src;
}

main().catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
});
