import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "atomy_auth";
const SESSION_HOURS = 12;
const REMEMBER_DAYS = 30;

type SessionPayload = {
  member_id: number;
  exp: number;
};

function getSecret() {
  return (
    process.env.AUTH_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "dev-secret-change-me"
  );
}

function b64url(input: Buffer | string) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64url(s: string) {
  const pad = 4 - (s.length % 4 || 4);
  const base = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad === 4 ? 0 : pad);
  return Buffer.from(base, "base64");
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, encoded: string) {
  try {
    const [algo, salt, hex] = String(encoded || "").split("$");
    if (algo !== "scrypt" || !salt || !hex) return false;
    const got = Buffer.from(hex, "hex");
    const cur = scryptSync(password, salt, 64);
    if (got.length !== cur.length) return false;
    return timingSafeEqual(got, cur);
  } catch {
    return false;
  }
}

export function signSession(member_id: number, remember = false) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (remember ? REMEMBER_DAYS * 24 * 60 * 60 : SESSION_HOURS * 60 * 60);
  const payload: SessionPayload = { member_id, exp };
  const payloadPart = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", getSecret()).update(payloadPart).digest();
  const sigPart = b64url(sig);
  return `${payloadPart}.${sigPart}`;
}

export function verifySessionToken(token?: string | null): SessionPayload | null {
  try {
    const t = String(token || "");
    const [payloadPart, sigPart] = t.split(".");
    if (!payloadPart || !sigPart) return null;
    const expected = createHmac("sha256", getSecret()).update(payloadPart).digest();
    const got = fromB64url(sigPart);
    if (expected.length !== got.length) return null;
    if (!timingSafeEqual(expected, got)) return null;
    const payload = JSON.parse(fromB64url(payloadPart).toString("utf8")) as SessionPayload;
    if (!payload?.member_id || !payload?.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function authCookieName() {
  return COOKIE_NAME;
}

export function authCookieMaxAge(remember = false) {
  return remember ? REMEMBER_DAYS * 24 * 60 * 60 : SESSION_HOURS * 60 * 60;
}

