import * as crypto from 'node:crypto';

const COOKIE_NAME = 'crf_session';

interface RateBucket {
  count: number;
  resetAt: number;
}

const FAIL_WINDOW_MS = 5 * 60 * 1000;
const FAIL_LIMIT = 5;

export class Auth {
  private token: string;
  private behindHttps: boolean;
  private sessionSecret: Buffer;
  private failures = new Map<string, RateBucket>();

  constructor(token: string, behindHttps: boolean) {
    if (!token) throw new Error('Auth requires a non-empty token');
    this.token = token;
    this.behindHttps = behindHttps;
    this.sessionSecret = crypto.randomBytes(32);
  }

  cookieName(): string {
    return COOKIE_NAME;
  }

  private signSession(): string {
    const issuedAt = Date.now().toString(36);
    const nonce = crypto.randomBytes(8).toString('base64url');
    const payload = `${issuedAt}.${nonce}`;
    const mac = crypto
      .createHmac('sha256', this.sessionSecret)
      .update(payload)
      .digest('base64url');
    return `${payload}.${mac}`;
  }

  private verifySession(value: string): boolean {
    const parts = value.split('.');
    if (parts.length !== 3) return false;
    const [issuedAt, nonce, mac] = parts;
    const expected = crypto
      .createHmac('sha256', this.sessionSecret)
      .update(`${issuedAt}.${nonce}`)
      .digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  parseCookie(header: string | undefined): string | null {
    if (!header) return null;
    for (const part of header.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === COOKIE_NAME) return rest.join('=');
    }
    return null;
  }

  isAuthenticated(cookieHeader: string | undefined): boolean {
    const value = this.parseCookie(cookieHeader);
    if (!value) return false;
    return this.verifySession(value);
  }

  // Returns Set-Cookie value on success, null on failure (with side effect:
  // increments rate limit on failure).
  attemptLogin(submittedToken: string, ip: string): string | null {
    if (this.isRateLimited(ip)) return null;
    if (!constantTimeEquals(submittedToken, this.token)) {
      this.recordFailure(ip);
      return null;
    }
    this.failures.delete(ip);
    const value = this.signSession();
    const attrs = [
      `${COOKIE_NAME}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=86400',
    ];
    if (this.behindHttps) attrs.push('Secure');
    return attrs.join('; ');
  }

  isRateLimited(ip: string): boolean {
    const bucket = this.failures.get(ip);
    if (!bucket) return false;
    if (Date.now() > bucket.resetAt) {
      this.failures.delete(ip);
      return false;
    }
    return bucket.count >= FAIL_LIMIT;
  }

  private recordFailure(ip: string): void {
    const now = Date.now();
    const existing = this.failures.get(ip);
    if (existing && now <= existing.resetAt) {
      existing.count += 1;
    } else {
      this.failures.set(ip, { count: 1, resetAt: now + FAIL_WINDOW_MS });
    }
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
