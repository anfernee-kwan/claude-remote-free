// WebSocket client for the terminal.
// Wire format mirrors src/server/ws.ts:
//   First byte = type (0x00 stdout, 0x01 stdin, 0x02 JSON control)
//   Remaining bytes = payload (raw or utf-8 JSON)

const TYPE_STDOUT = 0x00;
const TYPE_STDIN = 0x01;
const TYPE_JSON = 0x02;

type StdoutHandler = (data: Uint8Array) => void;
type JsonHandler = (msg: { type: string; [k: string]: unknown }) => void;
type StateHandler = (state: ConnState) => void;

export type ConnState = 'connecting' | 'open' | 'closed' | 'reconnecting';

export interface WsClientOpts {
  url: string;
  onStdout: StdoutHandler;
  onJson: JsonHandler;
  onState: StateHandler;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closed = false;
  private state: ConnState = 'connecting';

  constructor(private opts: WsClientOpts) {
    this.connect();
  }

  private setState(s: ConnState) {
    this.state = s;
    this.opts.onState(s);
  }

  private connect() {
    if (this.closed) return;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(this.opts.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.setState('open');
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') return; // ignore text frames
      const buf = new Uint8Array(ev.data as ArrayBuffer);
      if (buf.length < 1) return;
      const type = buf[0];
      const payload = buf.subarray(1);
      if (type === TYPE_STDOUT) {
        this.opts.onStdout(payload);
      } else if (type === TYPE_JSON) {
        try {
          const text = new TextDecoder('utf-8').decode(payload);
          const msg = JSON.parse(text);
          this.opts.onJson(msg);
        } catch {
          // ignore malformed
        }
      }
    };
    ws.onclose = () => {
      if (this.closed) {
        this.setState('closed');
        return;
      }
      this.attempt += 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt - 1, 5));
      this.setState('reconnecting');
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {
      // onclose will follow; nothing to do here
    };
  }

  sendStdin(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const enc = new TextEncoder().encode(text);
    const out = new Uint8Array(1 + enc.length);
    out[0] = TYPE_STDIN;
    out.set(enc, 1);
    this.ws.send(out.buffer);
  }

  sendResize(cols: number, rows: number): void {
    this.sendJson({ type: 'resize', cols, rows });
  }

  sendJson(msg: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const enc = new TextEncoder().encode(JSON.stringify(msg));
    const out = new Uint8Array(1 + enc.length);
    out[0] = TYPE_JSON;
    out.set(enc, 1);
    this.ws.send(out.buffer);
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {}
  }
}
