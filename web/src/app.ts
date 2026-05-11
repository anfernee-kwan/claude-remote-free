import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WsClient, ConnState } from './ws-client';

import 'xterm/css/xterm.css';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

async function whoami(): Promise<boolean> {
  try {
    const r = await fetch('/whoami', { credentials: 'same-origin' });
    if (!r.ok) return false;
    const j = await r.json();
    return !!j.authed;
  } catch {
    return false;
  }
}

async function bootLogin(): Promise<void> {
  const login = $('#login');
  const term = $('#terminal');
  login.classList.remove('hidden');
  term.classList.add('hidden');
  const form = $<HTMLFormElement>('#login-form');
  const input = $<HTMLInputElement>('#token');
  const msg = $('#login-msg');
  form.onsubmit = async (e) => {
    e.preventDefault();
    msg.textContent = '';
    const token = input.value.trim();
    if (!token) return;
    try {
      const r = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ token }),
      });
      if (r.ok) {
        input.value = '';
        bootTerminal();
        return;
      }
      if (r.status === 429) msg.textContent = 'too many attempts, try again later';
      else msg.textContent = 'invalid token';
    } catch (err) {
      msg.textContent = `network error: ${(err as Error).message}`;
    }
  };
}

function bootTerminal(): void {
  const login = $('#login');
  const term = $('#terminal');
  login.classList.add('hidden');
  term.classList.remove('hidden');

  const xterm = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: { background: '#0c0c0c', foreground: '#e0e0e0' },
    convertEol: false,
    allowProposedApi: true,
    scrollback: 5000,
  });
  const fit = new FitAddon();
  xterm.loadAddon(fit);
  xterm.open($('#xterm'));
  fit.fit();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${proto}://${location.host}/ws`;
  const status = $('#status');
  const decoder = new TextDecoder('utf-8');

  const client = new WsClient({
    url: wsUrl,
    onStdout: (bytes) => {
      // Note: passing a Uint8Array is supported by xterm via the SDK; falling
      // back to string for environments where it isn't.
      xterm.write(decoder.decode(bytes));
    },
    onJson: (msg) => {
      if (msg.type === 'exit') {
        const code = msg.code as number;
        const signal = msg.signal as number | undefined;
        xterm.write(`\r\n\x1b[33m[pty exited code=${code}${signal ? ` signal=${signal}` : ''}]\x1b[0m\r\n`);
      }
    },
    onState: (s) => {
      status.textContent = stateLabel(s);
      status.style.color = s === 'open' ? 'var(--accent)' : '#e88';
    },
  });

  xterm.onData((data) => client.sendStdin(data));

  // Resize: debounce so we don't spam the daemon during a drag.
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const sendResize = () => {
    fit.fit();
    client.sendResize(xterm.cols, xterm.rows);
  };
  const debouncedResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(sendResize, 100);
  };
  window.addEventListener('resize', debouncedResize);
  // Also send an initial resize once the WS is open.
  const initialResize = () => {
    if (xterm.cols && xterm.rows) {
      client.sendResize(xterm.cols, xterm.rows);
    }
  };
  setTimeout(initialResize, 50);

  // Paste: send the whole clipboard at once instead of letting the terminal
  // synthesise per-char events.
  $('#xterm').addEventListener('paste', (e) => {
    const data = (e as ClipboardEvent).clipboardData?.getData('text');
    if (data) {
      e.preventDefault();
      client.sendStdin(data);
    }
  });

  // Mobile soft key bar.
  const ctrlBtn = $<HTMLButtonElement>('#kb-ctrl');
  let ctrlSticky = false;
  ctrlBtn.addEventListener('click', () => {
    ctrlSticky = !ctrlSticky;
    ctrlBtn.classList.toggle('sticky-on', ctrlSticky);
  });
  document.querySelectorAll<HTMLButtonElement>('#keybar button[data-key]').forEach((btn) => {
    if (btn.id === 'kb-ctrl') return;
    btn.addEventListener('click', () => {
      const key = btn.dataset.key!;
      const seq = keyToSeq(key, ctrlSticky);
      if (seq) client.sendStdin(seq);
      if (ctrlSticky) {
        ctrlSticky = false;
        ctrlBtn.classList.remove('sticky-on');
      }
      // Refocus xterm so subsequent typing on the soft keyboard goes through.
      xterm.focus();
    });
  });

  // Logout.
  $('#logout').addEventListener('click', async () => {
    client.close();
    try {
      await fetch('/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {}
    location.reload();
  });
}

function stateLabel(s: ConnState): string {
  switch (s) {
    case 'connecting': return 'connecting...';
    case 'open': return 'connected';
    case 'reconnecting': return 'reconnecting...';
    case 'closed': return 'disconnected';
  }
}

function keyToSeq(key: string, ctrl: boolean): string {
  if (key.startsWith('C-')) {
    const ch = key.slice(2).toLowerCase();
    if (ch.length === 1 && ch >= 'a' && ch <= 'z') {
      return String.fromCharCode(ch.charCodeAt(0) - 96);
    }
    return '';
  }
  if (ctrl && key.length === 1) {
    const lower = key.toLowerCase();
    if (lower >= 'a' && lower <= 'z') return String.fromCharCode(lower.charCodeAt(0) - 96);
  }
  switch (key) {
    case 'Escape': return '\x1b';
    case 'Tab': return '\t';
    case 'ArrowUp': return '\x1b[A';
    case 'ArrowDown': return '\x1b[B';
    case 'ArrowRight': return '\x1b[C';
    case 'ArrowLeft': return '\x1b[D';
    default: return '';
  }
}

async function main() {
  const authed = await whoami();
  if (authed) bootTerminal();
  else bootLogin();
}

main();
