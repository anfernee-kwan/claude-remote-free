import * as pty from 'node-pty';
import { FreshOpts, PtySource } from './index';

export function createFreshSource(opts: FreshOpts): PtySource {
  const term = pty.spawn(opts.bin, opts.args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: opts.cwd,
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
    kind: 'fresh',
    write(data) {
      term.write(data);
    },
    resize(cols, rows) {
      try {
        term.resize(cols, rows);
      } catch {
        // resize on a dead pty throws; ignore
      }
    },
    close() {
      try {
        term.kill();
      } catch {
        // already dead
      }
    },
    onData(cb) {
      dataCbs.push(cb);
    },
    onExit(cb) {
      exitCbs.push(cb);
    },
  };
}
