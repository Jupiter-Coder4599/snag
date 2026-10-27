// PIN lock. The PIN itself is never stored: only a salted hash, kept in
// expo-secure-store (encrypted with Android's hardware-backed Keystore).
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

export const UNLOCK_MINUTES = 45;
const MAX_TRIES = 5;

const K = {
  hash: 'snag_pin_hash',
  salt: 'snag_pin_salt',
  until: 'snag_unlocked_until',
  fails: 'snag_pin_fails',
  lockout: 'snag_pin_lockout',
};

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

async function hashPin(pin, salt) {
  // Repeated hashing makes guessing from a stolen hash slower.
  let h = salt + pin;
  for (let i = 0; i < 200; i++) {
    h = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, salt + h);
  }
  return h;
}

async function getNum(key) {
  const v = await SecureStore.getItemAsync(key);
  return v ? Number(v) : 0;
}

async function startUnlockWindow() {
  const until = Date.now() + UNLOCK_MINUTES * 60 * 1000;
  await SecureStore.setItemAsync(K.until, String(until));
  return until;
}

export async function hasPin() {
  return !!(await SecureStore.getItemAsync(K.hash));
}

export async function getUnlockedUntil() {
  return getNum(K.until);
}

export async function lockNow() {
  await SecureStore.deleteItemAsync(K.until);
}

// Sets (or replaces) the PIN and unlocks for 45 minutes.
export async function setPin(pin) {
  const salt = toHex(Crypto.getRandomBytes(16));
  const hash = await hashPin(pin, salt);
  await SecureStore.setItemAsync(K.salt, salt);
  await SecureStore.setItemAsync(K.hash, hash);
  await SecureStore.deleteItemAsync(K.fails);
  await SecureStore.deleteItemAsync(K.lockout);
  return startUnlockWindow();
}

// Returns { ok, until } on success, or { ok: false, triesLeft | waitSec }.
export async function verifyPin(pin) {
  const lockout = await getNum(K.lockout);
  if (lockout > Date.now()) {
    return { ok: false, waitSec: Math.ceil((lockout - Date.now()) / 1000) };
  }
  const salt = await SecureStore.getItemAsync(K.salt);
  const stored = await SecureStore.getItemAsync(K.hash);
  if (!salt || !stored) return { ok: false, triesLeft: 0 };

  if ((await hashPin(pin, salt)) === stored) {
    await SecureStore.deleteItemAsync(K.fails);
    await SecureStore.deleteItemAsync(K.lockout);
    return { ok: true, until: await startUnlockWindow() };
  }

  const fails = (await getNum(K.fails)) + 1;
  await SecureStore.setItemAsync(K.fails, String(fails));
  if (fails >= MAX_TRIES) {
    // 30s, then 60s, 120s... up to 15 minutes.
    const wait = Math.min(30 * 2 ** (fails - MAX_TRIES), 900);
    await SecureStore.setItemAsync(K.lockout, String(Date.now() + wait * 1000));
    return { ok: false, waitSec: wait };
  }
  return { ok: false, triesLeft: MAX_TRIES - fails };
}
