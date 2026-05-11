import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { Auth } from './auth';

export interface HttpServerOpts {
  webDir: string; // directory with index.html and bundled assets
  auth: Auth;
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.map': 'application/json',
};

export function createHttpServer(opts: HttpServerOpts): http.Server {
  return http.createServer(async (req, res) => {
    try {
      await handle(req, res, opts);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`Internal error: ${(err as Error).message}`);
    }
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: HttpServerOpts,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const pathname = url.pathname;

  // Standard hardening headers for the HTML / login surfaces.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.method === 'POST' && pathname === '/login') {
    await handleLogin(req, res, opts);
    return;
  }

  if (req.method === 'POST' && pathname === '/logout') {
    res.setHeader('Set-Cookie', `${opts.auth.cookieName()}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (pathname === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }

  // Cheap endpoint the SPA uses to determine its current auth state on load
  // (so it knows whether to render the login form or the terminal).
  if (pathname === '/whoami') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ authed: opts.auth.isAuthenticated(req.headers.cookie) }));
    return;
  }

  // Static assets. Single-page: every public path renders index.html and the
  // client decides what to show. The WebSocket upgrade and /whoami are gated
  // by the auth cookie, so an unauthenticated client cannot reach the PTY
  // even with the JS in hand.
  const requestedFile = pathname === '/' ? '/index.html' : pathname;
  if (!/^\/[\w\-./]+$/.test(requestedFile) || requestedFile.includes('..')) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  const file = path.join(opts.webDir, requestedFile);
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(opts.webDir))) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.setHeader('Content-Type', STATIC_TYPES[ext] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(data);
  });
}

async function handleLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: HttpServerOpts,
): Promise<void> {
  const body = await readBody(req, 4096);
  let submitted = '';
  try {
    const parsed = JSON.parse(body || '{}');
    submitted = typeof parsed.token === 'string' ? parsed.token : '';
  } catch {
    res.statusCode = 400;
    res.end('Bad JSON');
    return;
  }
  const ip = clientIp(req);
  const cookie = opts.auth.attemptLogin(submitted, ip);
  if (!cookie) {
    if (opts.auth.isRateLimited(ip)) {
      res.statusCode = 429;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'rate_limited' }));
      return;
    }
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'bad_token' }));
    return;
  }
  res.setHeader('Set-Cookie', cookie);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let len = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      len += chunk.length;
      if (len > maxBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientIp(req: http.IncomingMessage): string {
  // Trust only socket-level IP. We bind to 127.0.0.1 by default; if behind a
  // tunnel, X-Forwarded-For is attacker-controlled unless the tunnel strips it.
  // Rate limiting on the socket peer is conservative and correct for the
  // intended single-tenant + tunnel deployment.
  return req.socket.remoteAddress ?? '0.0.0.0';
}
