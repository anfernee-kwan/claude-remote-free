import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { CONFIG_DIR, CONFIG_FILE } from './paths';

export type SourceKind = 'fresh' | 'wrapper' | 'tmux';

export interface Config {
  port: number;
  bind: string;
  token: string;
  claudeBin: string;
  claudeArgs: string[];
  cwd: string;
  env: Record<string, string>;
  allowedOrigins: string[];
}

const DEFAULTS: Config = {
  port: 7878,
  bind: '127.0.0.1',
  token: '',
  claudeBin: 'claude',
  claudeArgs: [],
  cwd: process.env.HOME ?? '/',
  env: {},
  allowedOrigins: ['http://localhost:7878', 'http://127.0.0.1:7878'],
};

export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function loadOrCreateConfig(): Config {
  ensureConfigDir();
  let cfg: Config;
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      cfg = { ...DEFAULTS, ...raw };
    } catch (err) {
      throw new Error(`Failed to parse ${CONFIG_FILE}: ${(err as Error).message}`);
    }
  } else {
    cfg = { ...DEFAULTS };
  }
  if (!cfg.token) {
    cfg.token = generateToken();
    saveConfig(cfg);
  }
  // Always include localhost variants for the current port
  const localOrigins = [`http://localhost:${cfg.port}`, `http://127.0.0.1:${cfg.port}`];
  for (const o of localOrigins) {
    if (!cfg.allowedOrigins.includes(o)) cfg.allowedOrigins.push(o);
  }
  return cfg;
}

export function saveConfig(cfg: Config): void {
  ensureConfigDir();
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
}

export function configFileLocation(): string {
  return CONFIG_FILE;
}

export function describeNonDefaultBind(bind: string): string | null {
  if (bind === '127.0.0.1' || bind === '::1' || bind === 'localhost') return null;
  return (
    `WARNING: bind=${bind} is NOT loopback. You are exposing the daemon directly.\n` +
    `         Make sure HTTPS + auth is enforced upstream (Cloudflare Tunnel / reverse proxy).\n` +
    `         Default deployment uses a tunnel (Tailscale / Cloudflare) and bind=127.0.0.1.`
  );
}

export function pathForReporting(): string {
  return path.relative(process.cwd(), CONFIG_FILE);
}
