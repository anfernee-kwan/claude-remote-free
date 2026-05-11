import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as pty from 'node-pty';
import { defaultWrapperSocketPath, STATE_DIR } from './paths';
import { ensureStateDir } from './pidfile';
import { encodeFrame, FRAME, FrameDecoder } from './server/source/wrapper';

export interface AttachOpts {
  command: string;
  args: string[];
  socketPath?: string;
}

// `claude-remote-free attach -- claude [args...]`
//
// Spawns the requested command in a PTY connected to the current TTY (so the
// user sees and interacts with it normally), and ALSO listens on a unix domain
// socket. A daemon started with --source wrapper connects to that socket and
// receives PTY output, sends stdin, and resize events. Multiple daemon clients
// can connect simultaneously (output is fanned out, input is merged).
export async function runAttach(opts: AttachOpts): Promise<void> {
  ensureStateDir();
  const sockPath = opts.socketPath ?? defaultWrapperSocketPath();

  // If a stale socket exists with no live owner, remove it.
  try {
    fs.unlinkSync(sockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const isTTY = process.stdin.isTTY && process.stdout.isTTY;
  if (!isTTY) {
    process.stderr.write('warning: stdin/stdout are not a TTY; attach mode still works but mirrors raw bytes\n');
  }

  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;

  const term = pty.spawn(opts.command, opts.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: process.env as { [key: string]: string },
  });

  const clients = new Set<net.Socket>();

  // Mirror PTY output to the local stdout and to all daemon clients.
  term.onData((data) => {
    const buf = Buffer.from(data, 'utf8');
    process.stdout.write(buf);
    const frame = encodeFrame(FRAME.STDOUT, buf);
    for (const c of clients) {
      if (!c.destroyed) c.write(frame);
    }
  });

  // Forward local stdin into the PTY.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.on('data', (chunk: Buffer) => {
    term.write(chunk.toString('utf8'));
  });

  // Track resize events from the local terminal.
  process.stdout.on('resize', () => {
    const c = process.stdout.columns ?? 80;
    const r = process.stdout.rows ?? 24;
    try {
      term.resize(c, r);
    } catch {}
  });

  // PTY exit -> notify everyone, clean up, exit ourselves with the same code.
  term.onExit(({ exitCode, signal }) => {
    const payload = JSON.stringify({ code: exitCode, signal });
    const frame = encodeFrame(FRAME.EXIT, payload);
    for (const c of clients) {
      try {
        c.write(frame);
        c.end();
      } catch {}
    }
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {}
    cleanup(sockPath);
    process.exit(exitCode);
  });

  // Listen for daemon connections.
  const server = net.createServer((sock) => {
    clients.add(sock);
    const decoder = new FrameDecoder();
    sock.on('data', (chunk) => {
      for (const f of decoder.push(chunk)) {
        if (f.type === FRAME.STDIN) {
          term.write(f.payload.toString('utf8'));
        } else if (f.type === FRAME.RESIZE) {
          try {
            const { cols: c, rows: r } = JSON.parse(f.payload.toString('utf8'));
            if (c && r) term.resize(c, r);
          } catch {}
        }
        // PING: ignore (presence on socket is enough)
      }
    });
    sock.on('close', () => clients.delete(sock));
    sock.on('error', () => clients.delete(sock));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => {
      try {
        fs.chmodSync(sockPath, 0o600);
      } catch {}
      resolve();
    });
  });

  const onExit = () => {
    try {
      term.kill();
    } catch {}
    cleanup(sockPath);
  };
  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);
  process.on('exit', () => cleanup(sockPath));

  process.stderr.write(
    `[claude-remote-free attach] socket=${sockPath}\n` +
      `[claude-remote-free attach] start the daemon with: claude-remote-free start --source wrapper\n`,
  );
}

function cleanup(sockPath: string): void {
  try {
    fs.unlinkSync(sockPath);
  } catch {}
  // Don't remove STATE_DIR — other state lives there.
  void STATE_DIR;
  void path;
}
