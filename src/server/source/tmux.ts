import * as pty from 'node-pty';
import { PtySource, TmuxOpts } from './index';

export function createTmuxSource(opts: TmuxOpts): PtySource {
  // Attach to an existing tmux session. tmux handles multi-client fan-out, resize
  // negotiation, and input merging across attached clients (local terminal + this
  // daemon-attached PTY). If the session does not exist, tmux exits with an error
  // visible in the web terminal.
  const term = pty.spawn('tmux', ['attach-session', '-t', opts.sessionName], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.env.HOME ?? '/',
    env: opts.env as { [key: string]: string },
  });

  const dataCbs: Array<(d: string) => void> = [];
  const exitCbs: Array<(code: number, signal?: number) => void> = [];

  term.onData((d) => {
    for (const cb of dataCbs) cb(d);
  });
  term.onExit(({ exitCode, signal }) => {
    for (const cb of exitCbs) cb(exitCode, signal);
  });

  return {
    kind: 'tmux',
    write(data) {
      term.write(data);
    },
    resize(cols, rows) {
      try {
        term.resize(cols, rows);
      } catch {}
    },
    close() {
      // Detach the tmux client; do NOT kill the underlying tmux session.
      try {
        term.write('\x02d'); // Ctrl-B then 'd' = tmux detach
      } catch {}
      setTimeout(() => {
        try {
          term.kill();
        } catch {}
      }, 200);
    },
    onData(cb) {
      dataCbs.push(cb);
    },
    onExit(cb) {
      exitCbs.push(cb);
    },
  };
}
