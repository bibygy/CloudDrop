// Optional Zero-Knowledge End-to-End Encryption (WebCrypto PBKDF2-SHA256 + AES-256-GCM)

const MAGIC = new Uint8Array([0x43, 0x44, 0x30, 0x31]); // "CD01"
const PBKDF2_ITERATIONS = 250000;
const CANARY_PLAINTEXT = 'clouddrop-e2ee-canary-v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function isCryptoAvailable() {
  return Boolean(globalThis.crypto && globalThis.crypto.subtle);
}

export function bytesToBase64(bytes) {
  let binary = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function generateSaltBase64() {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return bytesToBase64(salt);
}

export async function deriveKey(passphrase, saltBase64) {
  if (!isCryptoAvailable()) {
    throw new Error('当前环境不支持 WebCrypto（需要 HTTPS 或 localhost）');
  }
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const salt = base64ToBytes(saltBase64);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptJson(obj, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = encoder.encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return {
    __e2ee: 1,
    alg: 'AES-256-GCM',
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ct))
  };
}

export async function decryptJson(envelope, key) {
  if (!envelope || envelope.__e2ee !== 1) return envelope;
  const iv = base64ToBytes(envelope.iv);
  const ct = base64ToBytes(envelope.ct);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(decoder.decode(plain));
}

export async function encryptBlob(blob, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = await blob.arrayBuffer();
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(MAGIC.length + iv.length + ct.length);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(ct, MAGIC.length + iv.length);
  return new Blob([out], { type: 'application/octet-stream' });
}

export async function decryptBlob(blob, key, originalMimeType = 'application/octet-stream') {
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (
    buf.length < 28 ||
    buf[0] !== MAGIC[0] ||
    buf[1] !== MAGIC[1] ||
    buf[2] !== MAGIC[2] ||
    buf[3] !== MAGIC[3]
  ) {
    // Not encrypted (legacy/unencrypted blob)
    return new Blob([buf], { type: originalMimeType });
  }
  const iv = buf.subarray(4, 16);
  const ct = buf.subarray(16);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new Blob([plain], { type: originalMimeType });
}

export async function createCanary(key) {
  return encryptJson({ v: CANARY_PLAINTEXT }, key);
}

export async function verifyCanary(canary, key) {
  try {
    const res = await decryptJson(canary, key);
    return res && res.v === CANARY_PLAINTEXT;
  } catch {
    return false;
  }
}
