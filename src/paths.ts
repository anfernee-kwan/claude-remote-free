import * as os from 'node:os';
import * as path from 'node:path';

function xdg(envVar: string, fallback: string): string {
  const v = process.env[envVar];
  if (v && path.isAbsolute(v)) return v;
  return path.join(os.homedir(), fallback);
}

export const CONFIG_DIR = path.join(xdg('XDG_CONFIG_HOME', '.config'), 'claude-remote-free');
export const STATE_DIR = path.join(xdg('XDG_STATE_HOME', '.local/state'), 'claude-remote-free');

export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const PID_FILE = path.join(STATE_DIR, 'daemon.pid');
export const LOG_FILE = path.join(STATE_DIR, 'daemon.log');

export function wrapperSocketPath(pid: number): string {
  return path.join(STATE_DIR, `attach-${pid}.sock`);
}

export function defaultWrapperSocketPath(): string {
  return path.join(STATE_DIR, 'attach.sock');
}
