// Address derivation and base58 for idl-drift.
//
// Two on-chain locations hold a program's IDL:
//
// 1. The canonical Program Metadata `idl` account: PDA of
//    [program, seed("idl" padded to 16)] under ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S.
//    Anchor 1.0+ writes only this one.
// 2. The legacy Anchor IDL account: Pubkey::create_with_seed(base, "anchor:idl", program)
//    where base = find_program_address([], program). Written by `anchor idl init` before
//    Anchor 1.0.
//
// PDA derivation needs the ed25519 on-curve check (Solana's bytes_are_curve_point):
// a hash that lands on the curve is skipped and the bump is decremented.

import { createHash } from "node:crypto";

export const METADATA_PROGRAM =
  "ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S";

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map();
for (let i = 0; i < B58_ALPHABET.length; i++) {
  B58_INDEX.set(B58_ALPHABET[i], i);
}

export function base58Decode(input) {
  if (typeof input !== "string" || input.length === 0) {
    return new Uint8Array(0);
  }
  let zeros = 0;
  while (zeros < input.length && input[zeros] === "1") zeros++;
  const bytes = [0];
  for (let i = zeros; i < input.length; i++) {
    const v = B58_INDEX.get(input[i]);
    if (v === undefined) {
      throw new Error(`Invalid base58 character: ${input[i]}`);
    }
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[zeros + i] = bytes[bytes.length - 1 - i];
  }
  return out;
}

export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) {
    n = (n << 8n) | BigInt(b);
  }
  let s = "";
  while (n > 0n) {
    const r = Number(n % 58n);
    s = B58_ALPHABET[r] + s;
    n /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return "1".repeat(zeros) + s;
}

function sha256(...parts) {
  const h = createHash("sha256");
  for (const p of parts) h.update(Buffer.from(p));
  return new Uint8Array(h.digest());
}

// --- ed25519 on-curve check (BigInt, no dependencies) ---------------------

const P = (1n << 255n) - 19n;
const D = mod((-121665n) * modInv(121666n));
const SQRT_M1 = modPow(2n, (P - 1n) / 4n, P);

function mod(x) {
  const r = x % P;
  return r < 0n ? r + P : r;
}

function modPow(base, exp, m) {
  let result = 1n;
  base %= m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * base) % m;
    base = (base * base) % m;
    e >>= 1n;
  }
  return result;
}

function modInv(a) {
  return modPow(mod(a), P - 2n, P);
}

/** Whether the 32 bytes decompress to an ed25519 point (Solana's curve check). */
export function isOnCurve(bytes) {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 0; i < 32; i++) {
    y |= BigInt(bytes[i]) << (8n * BigInt(i));
  }
  const sign = y >> 255n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  if (v === 0n) return false;
  // x^2 = u / v; the point exists iff that is a square.
  const x2 = mod(u * modInv(v));
  if (x2 === 0n) return sign === 0n ? true : true; // x = 0 point exists for either sign bit
  let x = modPow(x2, (P + 3n) / 8n, P);
  if (mod(x * x) !== x2) {
    x = mod(x * SQRT_M1);
    if (mod(x * x) !== x2) return false;
  }
  return true;
}

/** Pubkey::find_program_address: first bump from 255 down whose hash is off-curve. */
export function findProgramAddress(seeds, program) {
  for (let bump = 255; bump >= 0; bump--) {
    const candidate = sha256(...seeds, Uint8Array.of(bump), program, Buffer.from("ProgramDerivedAddress"));
    if (!isOnCurve(candidate)) return candidate;
  }
  throw new Error("No program address found for seeds");
}

/** The canonical Program Metadata `idl` account of `programKey` (32 bytes). */
export function metadataAddress(programKey) {
  const seed = Buffer.alloc(16);
  Buffer.from("idl").copy(seed);
  return findProgramAddress([programKey, seed], base58Decode(METADATA_PROGRAM));
}

/** The legacy Anchor IDL account: create_with_seed(PDA([]), "anchor:idl", program). */
export function anchorIdlAddress(programKey) {
  const base = findProgramAddress([], programKey);
  return sha256(base, Buffer.from("anchor:idl"), programKey);
}
