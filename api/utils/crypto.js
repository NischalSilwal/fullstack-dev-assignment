import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;  // Recommended for GCM
const TAG_BYTES = 16;  // Standard auth tag length

// Derive 32-byte key from hex string in env
function getKey() {
  const hex = process.env.MASTER_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('MASTER_KEY must be a 64-character hex string. Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(hex, 'hex');
}

// Encrypt plaintext and return base64url string safe for DB storage
export function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  // Store IV + auth tag + ciphertext together
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

// Decrypt stored payload, throws if auth tag is invalid (tampered data)
export function decrypt(payload) {
  const buf = Buffer.from(payload, 'base64url');
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);

  return decipher.update(ciphertext) + decipher.final('utf8');
}
