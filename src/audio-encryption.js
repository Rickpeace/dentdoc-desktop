/**
 * Audio Encryption (AES-256-GCM)
 *
 * Encrypts/decrypts audio files at rest using a per-session runtime key
 * held only in RAM (never persisted). On app crash/restart the key is lost
 * and any leftover .enc files become permanently undecryptable; the app's
 * startup wipe removes them anyway.
 *
 * .enc file format: [12-byte IV][16-byte authTag][ciphertext]
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;

const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = IV_LEN + TAG_LEN;

let runtimeKey = null;

function initKey() {
  runtimeKey = crypto.randomBytes(32);
}

function isInitialized() {
  return runtimeKey !== null;
}

function getKey() {
  if (!runtimeKey) {
    throw new Error('[audio-encryption] runtime key not initialized - call initKey() at app start');
  }
  return runtimeKey;
}

async function encryptFile(plainPath, encPath) {
  const plain = await fsp.readFile(plainPath);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  await fsp.writeFile(encPath, Buffer.concat([iv, authTag, ciphertext]));
}

async function decryptFile(encPath, plainPath) {
  const buf = await decryptToBuffer(encPath);
  await fsp.writeFile(plainPath, buf);
}

async function decryptToBuffer(encPath) {
  const enc = await fsp.readFile(encPath);
  if (enc.length < HEADER_LEN) {
    throw new Error(`[audio-encryption] file too short to be valid .enc: ${encPath}`);
  }
  const iv = enc.subarray(0, IV_LEN);
  const authTag = enc.subarray(IV_LEN, HEADER_LEN);
  const ciphertext = enc.subarray(HEADER_LEN);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Returns a Readable stream of the decrypted bytes.
 * Header (IV+authTag) is read synchronously up front; ciphertext is piped through decipher.
 */
async function createDecryptStream(encPath) {
  const fd = await fsp.open(encPath, 'r');
  const header = Buffer.alloc(HEADER_LEN);
  try {
    await fd.read(header, 0, HEADER_LEN, 0);
  } finally {
    await fd.close();
  }
  const iv = header.subarray(0, IV_LEN);
  const authTag = header.subarray(IV_LEN, HEADER_LEN);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return fs.createReadStream(encPath, { start: HEADER_LEN }).pipe(decipher);
}

/**
 * Overwrites the file once with random bytes, then unlinks.
 * Best-effort: on locked files / SSD wear-leveling this is not forensically clean,
 * but combined with encryption it's defense-in-depth.
 */
async function secureDelete(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = await fsp.stat(filePath);
    if (stat.size > 0) {
      const fd = await fsp.open(filePath, 'r+');
      try {
        const chunkSize = 64 * 1024;
        let written = 0;
        while (written < stat.size) {
          const len = Math.min(chunkSize, stat.size - written);
          await fd.write(crypto.randomBytes(len), 0, len, written);
          written += len;
        }
        await fd.sync();
      } finally {
        await fd.close();
      }
    }
    await fsp.unlink(filePath);
  } catch (e) {
    console.warn('[audio-encryption] secureDelete overwrite failed:', filePath, e.message);
    try { await fsp.unlink(filePath); } catch (_) { /* swallow */ }
  }
}

module.exports = {
  initKey,
  isInitialized,
  encryptFile,
  decryptFile,
  decryptToBuffer,
  createDecryptStream,
  secureDelete,
};
