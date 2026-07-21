import { hash, type Algorithm, type Options } from '@node-rs/argon2';

/**
 * Password hashing, isolated behind one function so the rest of the code never
 * touches a raw password or the argon2 knobs. The stored string is argon2id's
 * self-describing encoding (`$argon2id$v=19$m=...$salt$hash`), so the salt and
 * parameters travel with the hash and a future verify needs nothing else.
 *
 * Callers must never log the plaintext or the returned hash.
 */

// argon2id is the memory-hard, side-channel-resistant variant OWASP recommends;
// selecting it is the one knob we override — the library's default cost
// parameters are left in place. `Algorithm` is an ambient const enum, which
// `verbatimModuleSyntax` forbids importing as a value, so we use its numeric
// member (Argon2id = 2) directly.
const OPTIONS: Options = { algorithm: 2 as Algorithm };

export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, OPTIONS);
}
