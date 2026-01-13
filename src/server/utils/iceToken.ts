const te = new TextEncoder();
const td = new TextDecoder();

function b64urlFromBytes(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesFromB64url(b64url: string) {
  let s = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importHmacKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function sign(key: CryptoKey, msg: string) {
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(msg));
  return b64urlFromBytes(new Uint8Array(sig));
}

async function verify(key: CryptoKey, msg: string, sigB64url: string) {
  const sig = bytesFromB64url(sigB64url);
  return crypto.subtle.verify("HMAC", key, sig, te.encode(msg));
}

// Token format: base64url(payload) + "." + base64url(hmac)
// payload is a compact string: appId|roomId|userId|expMs|nonce
export async function mintIceToken(opts: {
  secret: string;
  appId?: string;
  roomId?: string;
  userId?: string;
  ttlMs: number;
}) {
  const expiration = Date.now() + opts.ttlMs;
  const nonce = crypto.randomUUID();
  const payload = `${opts.appId}|${opts.roomId}|${opts.userId}|${expiration}|${nonce}`;

  const key = await importHmacKey(opts.secret);
  const sig = await sign(key, payload);

  const payloadB64 = b64urlFromBytes(te.encode(payload));
  return { token: `${payloadB64}.${sig}`, expiration };
}

export async function verifyIceToken(opts: {
  secret: string;
  token: string | null;
}) {
  const parts = opts.token?.split(".");
  if (parts?.length !== 2) return null;

  const [payloadB64, sig] = parts;

  const payload = td.decode(bytesFromB64url(payloadB64));

  const key = await importHmacKey(opts.secret);
  const ok = await verify(key, payload, sig);
  if (!ok) return null;

  const [appId, roomId, userId, expMsStr] = payload.split("|");
  const expiration = Number(expMsStr);
  if (!Number.isFinite(expiration) || Date.now() > expiration) return null;

  return { appId, roomId, userId, expiration };
}
