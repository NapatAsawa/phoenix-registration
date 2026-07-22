/**
 * Edge validation for `POST /registrations`. Turns an untrusted request body
 * into either a clean `RegistrationInput` or a list of field errors the route
 * renders as 400. Kept as a pure function so the whole 202-vs-400 decision is
 * unit-testable without HTTP or a database.
 */

// Password policy (issue #3): a floor that rules out trivially weak secrets and a
// ceiling that caps the argon2 work an unauthenticated caller can trigger.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

// Deliberately permissive: reject the obviously-malformed (spaces, no `@`, no
// domain dot) without trying to fully parse RFC 5322. Real proof of ownership is
// the Confirmation Email, not this regex.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RegistrationInput {
  email: string;
  password: string;
}

/**
 * Canonical form of an email for storage and lookup: trimmed and lower-cased.
 * Registration stores this, so every later lookup (Resend, verify) must apply the
 * same normalization or it won't find the row.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export type ValidationResult =
  | { ok: true; value: RegistrationInput }
  | { ok: false; errors: string[] };

export function parseRegistration(body: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof body !== 'object' || body === null) {
    return { ok: false, errors: ['body must be a JSON object'] };
  }

  const record = body as Record<string, unknown>;
  const { email, password } = record;

  // Normalize before testing so surrounding whitespace and case don't matter.
  const normalizedEmail = typeof email === 'string' ? normalizeEmail(email) : undefined;
  if (normalizedEmail === undefined || !EMAIL_PATTERN.test(normalizedEmail)) {
    errors.push('email must be a valid email address');
  }

  if (typeof password !== 'string') {
    errors.push('password is required');
  } else if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    errors.push(
      `password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    // normalizedEmail is defined here: reaching this point means it passed the
    // pattern test above. The password cast is safe for the same reason.
    value: { email: normalizedEmail as string, password: password as string },
  };
}
