import { pgTable, uuid, timestamp } from 'drizzle-orm/pg-core';

/**
 * The central domain table. This walking skeleton establishes only the identity
 * and audit columns so the migration harness has something real to run; the
 * registration columns (email, status, password hash, verification token, resend
 * bookkeeping) are added by a follow-up migration in issue #3.
 */
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
