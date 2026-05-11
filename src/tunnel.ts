import { spawn } from 'node:child_process';

const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export async function startCloudflareTunnel(
  port: number,
  onUrl: (url: string) => void,
): Promise<{ kill(): void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'cloudflared',
      ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let resolved = false;
    const onChunk = (chunk: Buffer) => {
      const m = chunk.toString('utf8').match(TRYCLOUDFLARE_URL_RE);
      if (m && !resolved) {
        resolved = true;
        onUrl(m[0]);
        resolve({
          kill() {
            try {
              child.kill();
            } catch {}
          },
        });
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (err) => {
      if (!resolved) reject(err);
    });
    child.on('exit', (code) => {
      if (!resolved) reject(new Error(`cloudflared exited with code ${code} before printing URL`));
    });
    setTimeout(() => {
      if (!resolved) reject(new Error('cloudflared did not produce a URL within 30s'));
    }, 30_000).unref();
  });
}
