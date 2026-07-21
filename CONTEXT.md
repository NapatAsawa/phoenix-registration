# Phoenix Registration

The domain of creating and confirming new user accounts. A person submits registration
details; the service creates a pending account, confirms ownership of the email, and
activates the account.

## Language

**Registration**:
A user's request to create a new account, and the workflow that processes it from
submission through email confirmation to an active account.
_Avoid_: Signup (as a noun), enrollment

**Account**:
The identity created for a person as the result of a successful registration.
Lifecycle: **Pending** (created, email not yet confirmed) → **Active** (email
confirmed, account usable). A Pending account that is never confirmed **Expires**.
_Avoid_: User (when meaning the record), profile

**Verification**:
The act of proving control of the submitted email address by following the
confirmation link. Activation is gated on verification.
_Avoid_: Validation, activation (as a synonym for the whole step)

**Confirmation Email**:
The message sent to a newly-registered person containing the confirmation link they
follow to verify their email and activate the account.
_Avoid_: Welcome email, notification

**Verification Token**:
The single-use secret carried in the confirmation link that proves the click came from
the person who received the Confirmation Email. Valid for a limited window (24h).
_Avoid_: Code, OTP, key

**Resend**:
Issuing a fresh Confirmation Email for a still-Pending account, replacing the previous
Verification Token. Subject to a minimum interval and a maximum count per account.
_Avoid_: Retry (which refers to the email job's internal delivery attempts)

**Sweep**:
The scheduled pass that expires (and removes) Pending accounts older than the Pending
TTL, freeing their email address for a new registration.
_Avoid_: Cleanup, garbage collection, purge
