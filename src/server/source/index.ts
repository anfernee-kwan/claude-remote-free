export interface PtySource {
  readonly kind: 'fresh' | 'wrapper' | 'tmux';
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  // Backpressure: when the downstream (WS clients) can't drain fast enough,
  // the ws layer calls pause() and pairs it with resume() once headroom
  // returns. Sources that can't actually pause (e.g. a remote socket) may
  // implement these as no-ops; the worst case is OS-buffered growth, which
  // is bounded.
  pause(): void;
  resume(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number, signal?: number) => void): void;
}

export interface FreshOpts {
  kind: 'fresh';
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface WrapperOpts {
  kind: 'wrapper';
  socketPath: string;
}

export interface TmuxOpts {
  kind: 'tmux';
  sessionName: string;
  env: NodeJS.ProcessEnv;
}

export type SourceOpts = FreshOpts | WrapperOpts | TmuxOpts;

export async function createSource(opts: SourceOpts): Promise<PtySource> {
  switch (opts.kind) {
    case 'fresh': {
      const { createFreshSource } = await import('./fresh');
      return createFreshSource(opts);
    }
    case 'wrapper': {
      const { createWrapperSource } = await import('./wrapper');
      return createWrapperSource(opts);
    }
    case 'tmux': {
      const { createTmuxSource } = await import('./tmux');
      return createTmuxSource(opts);
    }
  }
}
