import * as fs from 'node:fs';
import { PID_FILE, STATE_DIR } from './paths';

export function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

export function writePidFile(pid: number): void {
  ensureStateDir();
  fs.writeFileSync(PID_FILE, String(pid) + '\n', { mode: 0o600 });
}

export function readPidFile(): number | null {
  if (!fs.existsSync(PID_FILE)) return null;
  const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return pid;
}

export function removePidFile(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
