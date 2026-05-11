import { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Socket } from 'node:net';
import type { Auth } from './auth';
import type { PtySource } from './source';

// Wire protocol on the browser WebSocket:
//   First byte of every binary frame = type:
//     0x00 = stdout (server -> client, raw bytes)
//     0x01 = stdin  (client -> server, raw bytes)
//     0x02 = JSON   (either direction) — control messages
//   JSON control messages have shape { type: string, ... }:
//     { type: 'resize', cols, rows }   client -> server
//     { type: 'ping' }                 either
//     { type: 'pong' }                 either
//     { type: 'exit', code, signal? }  server -> client (PTY died)

const TYPE_STDOUT = 0x00;
const TYPE_STDIN = 0x01;
const TYPE_JSON = 0x02;

const REPLAY_BUFFER_BYTES = 64 * 1024;
// Pause PTY when total bytes buffered across all WS clients exceeds the high
// watermark; resume when it drops below the low watermark. Hysteresis avoids
// flapping when buffers oscillate just at the threshold.
const BACKPRESSURE_HIGH = 4 * 1024 * 1024;
const BACKPRESSURE_LOW = 1 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 100;

export interface WsServerOpts {
  httpServer: HttpServer;
  auth: Auth;
  source: PtySource;
  allowedOrigins: string[];
}

export function attachWsServer(opts: WsServerOpts): { close(): void } {
  const wss = new WebSocketServer({ noServer: true });
  const replay = new RingBuffer(REPLAY_BUFFER_BYTES);
  const clients = new Set<WebSocket>();
  let exitInfo: { code: number; signal?: number } | null = null;
  let paused = false;

  function totalBuffered(): number {
    let total = 0;
    for (const ws of clients) total += ws.bufferedAmount;
    return total;
  }

  function checkBackpressure(): void {
    const total = totalBuffered();
    if (!paused && total > BACKPRESSURE_HIGH) {
      paused = true;
      opts.source.pause();
    } else if (paused && total < BACKPRESSURE_LOW) {
      paused = false;
      opts.source.resume();
    }
  }

  // Poll periodically so we resume promptly once buffers drain even if no new
  // input arrives. Cleared in close().
  const backpressureTimer = setInterval(checkBackpressure, BACKPRESSURE_POLL_MS);
  backpressureTimer.unref();

  // Buffer PTY output. Every byte produced goes into the replay buffer (so a
  // reconnecting client can catch up) and gets broadcast to all live clients.
  opts.source.onData((data) => {
    const buf = Buffer.from(data, 'utf8');
    replay.push(buf);
    const frame = Buffer.concat([Buffer.from([TYPE_STDOUT]), buf]);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    }
    checkBackpressure();
  });

  opts.source.onExit((code, signal) => {
    exitInfo = { code, signal };
    const msg = JSON.stringify({ type: 'exit', code, signal });
    const frame = Buffer.concat([Buffer.from([TYPE_JSON]), Buffer.from(msg, 'utf8')]);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    }
  });

  function handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    if (req.url !== '/ws') {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (origin && !opts.allowedOrigins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!opts.auth.isAuthenticated(req.headers.cookie)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(ws);
    });
  }

  function onConnection(ws: WebSocket): void {
    clients.add(ws);

    // Replay buffered output so the client sees recent context.
    const snapshot = replay.snapshot();
    if (snapshot.length > 0) {
      ws.send(Buffer.concat([Buffer.from([TYPE_STDOUT]), snapshot]));
    }
    if (exitInfo) {
      const msg = JSON.stringify({ type: 'exit', ...exitInfo });
      ws.send(Buffer.concat([Buffer.from([TYPE_JSON]), Buffer.from(msg, 'utf8')]));
    }

    ws.on('message', (data, isBinary) => {
      if (!isBinary && !Buffer.isBuffer(data)) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (buf.length < 1) return;
      const type = buf.readUInt8(0);
      const payload = buf.subarray(1);
      if (type === TYPE_STDIN) {
        opts.source.write(payload.toString('utf8'));
      } else if (type === TYPE_JSON) {
        let msg: { type?: string; cols?: number; rows?: number };
        try {
          msg = JSON.parse(payload.toString('utf8'));
        } catch {
          return;
        }
        if (msg.type === 'resize' && msg.cols && msg.rows) {
          opts.source.resize(msg.cols, msg.rows);
        } else if (msg.type === 'ping') {
          const reply = JSON.stringify({ type: 'pong' });
          ws.send(Buffer.concat([Buffer.from([TYPE_JSON]), Buffer.from(reply, 'utf8')]));
        }
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });
  }

  opts.httpServer.on('upgrade', handleUpgrade);

  return {
    close() {
      clearInterval(backpressureTimer);
      for (const ws of clients) {
        try {
          ws.close();
        } catch {}
      }
      wss.close();
    },
  };
}

// Simple byte ring buffer for replay. Keeps the most recent N bytes.
class RingBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly capacity: number) {}

  push(buf: Buffer): void {
    if (buf.length === 0) return;
    if (buf.length >= this.capacity) {
      this.chunks = [buf.subarray(buf.length - this.capacity)];
      this.size = this.capacity;
      return;
    }
    this.chunks.push(buf);
    this.size += buf.length;
    while (this.size > this.capacity) {
      const head = this.chunks[0];
      const drop = Math.min(head.length, this.size - this.capacity);
      if (drop === head.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(drop);
      }
      this.size -= drop;
    }
  }

  snapshot(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }
}
