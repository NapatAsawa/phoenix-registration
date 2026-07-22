import { randomBytes, createHash } from 'node:crypto';

/**
 * Verification Token minting and hashing (CONTEXT.md). The plaintext token is
 * the secret carried in the confirmation link and handed to the person; only its
 * sha256 (`tokenHash`) is ever persisted, so a database leak cannot be replayed
 * into an account takeover. sha256 (not argon2) is right here because the token
 * is already high-entropy random — there is nothing to brute-force — and verify
 * must be a fast, constant-work lookup.
 */

/** Verification Token lifetime: 24h per CONTEXT.md. */
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** 256 bits of entropy, url-safe so it drops straight into a link. */
const TOKEN_BYTES = 32;

export interface VerificationToken {
  /** The secret to email; never stored. */
  token: string;
  /** sha256(token) hex; the only form persisted. */
  tokenHash: string;
}

/** A freshly-minted token together with the expiry to persist alongside it. */
export interface MintedVerificationToken extends VerificationToken {
  /** now + {@link VERIFICATION_TOKEN_TTL_MS}; the value written to `token_expires_at`. */
  expiresAt: Date;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateVerificationToken(): VerificationToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/**
 * A new Verification Token plus its expiry — the exact trio that registration and
 * Resend both write onto an account row. Keeping the TTL arithmetic here (next to
 * the TTL constant) means the two write sites don't each restate it.
 */
export function mintVerificationToken(): MintedVerificationToken {
  return { ...generateVerificationToken(), expiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS) };
}
