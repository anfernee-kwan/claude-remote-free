export interface PtySource {
  readonly kind: 'fresh' | 'wrapper' | 'tmux';
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
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
