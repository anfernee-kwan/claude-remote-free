import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadOrCreateConfig, describeNonDefaultBind, configFileLocation } from './config';
import { writePidFile, removePidFile, ensureStateDir } from './pidfile';
import { LOG_FILE, defaultWrapperSocketPath } from './paths';
import { Auth } from './server/auth';
import { createHttpServer } from './server/http';
import { attachWsServer } from './server/ws';
import { createSource, SourceOpts } from './server/source';
import { startCloudflareTunnel } from './tunnel';

export interface DaemonOpts {
  source: 'fresh' | 'wrapper' | 'tmux';
  tmuxSession?: string;
  wrapperSocket?: string;
  port?: number;
  bind?: string;
  behindHttps: boolean;
  tunnel?: 'cloudflare';
  webDir: string;
}

export async function runDaemon(opts: DaemonOpts): Promise<void> {
  ensureStateDir();
  const cfg = loadOrCreateConfig();
  if (opts.port) cfg.port = opts.port;
  if (opts.bind) cfg.bind = opts.bind;

  const warn = describeNonDefaultBind(cfg.bind);
  if (warn) log(warn);

  const env: NodeJS.ProcessEnv = { ...process.env, ...cfg.env };

  let sourceOpts: SourceOpts;
  if (opts.source === 'wrapper') {
    sourceOpts = {
      kind: 'wrapper',
      socketPath: opts.wrapperSocket ?? defaultWrapperSocketPath(),
    };
  } else if (opts.source === 'tmux') {
    if (!opts.tmuxSession) throw new Error('--tmux requires a session name');
    sourceOpts = { kind: 'tmux', sessionName: opts.tmuxSession, env };
  } else {
    sourceOpts = {
      kind: 'fresh',
      bin: cfg.claudeBin,
      args: cfg.claudeArgs,
      cwd: expandHome(cfg.cwd),
      env,
    };
  }

  const source = await createSource(sourceOpts);
  const auth = new Auth(cfg.token, opts.behindHttps);
  const httpServer = createHttpServer({ webDir: opts.webDir, auth });
  attachWsServer({
    httpServer,
    auth,
    source,
    allowedOrigins: cfg.allowedOrigins,
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(cfg.port, cfg.bind, () => resolve());
  });

  writePidFile(process.pid);

  const displayUrl = `http://${cfg.bind === '0.0.0.0' ? '<host>' : cfg.bind}:${cfg.port}`;
  log(`claude-remote-free listening on ${displayUrl}`);
  log(`source=${opts.source}` + (opts.tmuxSession ? ` tmux=${opts.tmuxSession}` : ''));
  log(`token (config: ${configFileLocation()}): ${cfg.token}`);
  log(`open ${displayUrl} and paste the token to log in`);

  let tunnelProc: { kill(): void } | null = null;
  if (opts.tunnel === 'cloudflare') {
    try {
      tunnelProc = await startCloudflareTunnel(cfg.port, (url) => {
        log(`cloudflare tunnel: ${url}`);
        if (!cfg.allowedOrigins.includes(url)) cfg.allowedOrigins.push(url);
      });
    } catch (err) {
      log(`failed to start cloudflare tunnel: ${(err as Error).message}`);
    }
  }

  const shutdown = (sig: string) => {
    log(`received ${sig}, shutting down`);
    try {
      source.close();
    } catch {}
    try {
      tunnelProc?.kill();
    } catch {}
    httpServer.close(() => {
      removePidFile();
      process.exit(0);
    });
    setTimeout(() => {
      removePidFile();
      process.exit(1);
    }, 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  source.onExit((code, signal) => {
    log(`pty exited code=${code}${signal ? ` signal=${signal}` : ''}; daemon staying up so the browser can see the exit`);
  });
}

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(process.env.HOME ?? '/', p.slice(1));
  return p;
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  // Also append to log file when detached (stdout is /dev/null in that case
  // but the daemon driver opens LOG_FILE as stdout/stderr fd).
}

// When this module is invoked directly (i.e. as the daemon process), parse
// argv from environment and run.
if (require.main === module) {
  const opts: DaemonOpts = {
    source: (process.env.CRF_SOURCE as DaemonOpts['source']) ?? 'fresh',
    tmuxSession: process.env.CRF_TMUX,
    wrapperSocket: process.env.CRF_WRAPPER_SOCKET,
    port: process.env.CRF_PORT ? Number(process.env.CRF_PORT) : undefined,
    bind: process.env.CRF_BIND,
    behindHttps: process.env.CRF_BEHIND_HTTPS === '1',
    tunnel: (process.env.CRF_TUNNEL as 'cloudflare') ?? undefined,
    webDir: process.env.CRF_WEB_DIR ?? path.resolve(__dirname, '..', 'web', 'dist'),
  };
  runDaemon(opts).catch((err) => {
    process.stderr.write(`daemon error: ${(err as Error).stack ?? err}\n`);
    fs.appendFileSync(LOG_FILE, `daemon error: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
