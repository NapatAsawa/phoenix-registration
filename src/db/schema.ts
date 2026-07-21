import { pgTable, uuid, timestamp, text } from 'drizzle-orm/pg-core';

/**
 * The Account lifecycle (CONTEXT.md): Pending on creation, Active once the email
 * is verified. Defined once here so the string literals aren't retyped (and
 * mistyped) across the write model, the registration service, and the worker.
 */
export const ACCOUNT_STATUS = { pending: 'pending', active: 'active' } as const;
export type AccountStatus = (typeof ACCOUNT_STATUS)[keyof typeof ACCOUNT_STATUS];

/**
 * The central domain table: one row per Account (CONTEXT.md).
 *
 * A registration inserts a row in status `pending`; verification flips it to
 * `active`. `email` is UNIQUE so a second registration for the same address is
 * rejected at the database, not just the application. The password is stored only
 * as an argon2id hash (`password_hash`), never in plaintext.
 *
 * `token_hash` / `token_expires_at` hold the current Verification Token: the
 * worker stores the sha256 of the token it emailed (never the token itself) plus
 * its 24h expiry. They are nullable because they are populated when the
 * Confirmation Email is sent, a step after the account row is created.
 */
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  status: text('status').notNull().default(ACCOUNT_STATUS.pending),
  passwordHash: text('password_hash').notNull(),
  tokenHash: text('token_hash'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
