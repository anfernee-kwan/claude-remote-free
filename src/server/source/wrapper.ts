import * as net from 'node:net';
import { PtySource, WrapperOpts } from './index';

// Wire protocol (newline-delimited JSON for control + raw bytes for I/O):
//   Frames are length-prefixed: 4-byte big-endian uint32 length, then 1 byte type,
//   then payload of length-1 bytes.
//   Types:
//     0x10 = stdout from claude (server -> attach client)
//     0x11 = stdin to claude   (attach client -> server)
//     0x12 = resize {cols,rows} JSON in payload
//     0x13 = exit  {code,signal} JSON in payload (server -> attach client)
//     0x14 = ping  (either direction)

export const FRAME = {
  STDOUT: 0x10,
  STDIN: 0x11,
  RESIZE: 0x12,
  EXIT: 0x13,
  PING: 0x14,
} as const;

export function encodeFrame(type: number, payload: Buffer | string): Buffer {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const out = Buffer.allocUnsafe(4 + 1 + buf.length);
  out.writeUInt32BE(1 + buf.length, 0);
  out.writeUInt8(type, 4);
  buf.copy(out, 5);
  return out;
}

export class FrameDecoder {
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Buffer): Array<{ type: number; payload: Buffer }> {
    this.chunks.push(chunk);
    this.size += chunk.length;
    const out: Array<{ type: number; payload: Buffer }> = [];
    while (this.size >= 4) {
      const head = this.peek(4);
      const len = head.readUInt32BE(0);
      if (this.size < 4 + len) break;
      this.consume(4);
      const frame = this.consume(len);
      out.push({ type: frame.readUInt8(0), payload: frame.subarray(1) });
    }
    return out;
  }

  private peek(n: number): Buffer {
    const merged = Buffer.concat(this.chunks);
    this.chunks = [merged];
    return merged.subarray(0, n);
  }

  private consume(n: number): Buffer {
    const merged = Buffer.concat(this.chunks);
    const out = merged.subarray(0, n);
    const rest = merged.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.size -= n;
    return Buffer.from(out);
  }
}

export function createWrapperSource(opts: WrapperOpts): PtySource {
  const dataCbs: Array<(d: string) => void> = [];
  const exitCbs: Array<(code: number, signal?: number) => void> = [];
  const decoder = new FrameDecoder();
  let socket: net.Socket | null = null;
  let closed = false;

  function connect(): net.Socket {
    const s = net.createConnection(opts.socketPath);
    s.on('data', (chunk) => {
      for (const f of decoder.push(chunk)) {
        if (f.type === FRAME.STDOUT) {
          const text = f.payload.toString('utf8');
          for (const cb of dataCbs) cb(text);
        } else if (f.type === FRAME.EXIT) {
          let info: { code: number; signal?: number } = { code: 0 };
          try {
            info = JSON.parse(f.payload.toString('utf8'));
          } catch {}
          for (const cb of exitCbs) cb(info.code ?? 0, info.signal);
        }
        // PING is just a keepalive; nothing to do
      }
    });
    s.on('error', (err) => {
      for (const cb of dataCbs) cb(`\r\n[wrapper] socket error: ${err.message}\r\n`);
    });
    s.on('close', () => {
      if (!closed) {
        for (const cb of exitCbs) cb(1);
      }
    });
    return s;
  }

  socket = connect();

  return {
    kind: 'wrapper',
    write(data) {
      socket?.write(encodeFrame(FRAME.STDIN, data));
    },
    resize(cols, rows) {
      socket?.write(encodeFrame(FRAME.RESIZE, JSON.stringify({ cols, rows })));
    },
    close() {
      closed = true;
      try {
        socket?.end();
      } catch {}
    },
    onData(cb) {
      dataCbs.push(cb);
    },
    onExit(cb) {
      exitCbs.push(cb);
    },
  };
}
