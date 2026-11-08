-- One-time codes for a lost authenticator. Hashes only: each code carries 75 random bits, so a slow hash adds nothing.
ALTER TABLE users ADD COLUMN totp_recovery_hashes text[] NOT NULL DEFAULT '{}';
