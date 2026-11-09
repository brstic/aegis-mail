-- A sender exception: the detectors flagged mail from this sender, and a review (the AI's, or the mailbox owner releasing
-- it) found it was ordinary mail. Recorded on the contact so the same sender isn't flagged for looking unfamiliar again.
-- It never covers malware or a forged sender: the engine applies it only when the provider's DMARC verdict isn't a failure.
--
--   trusted_scope  'sender' covers this one address. 'domain' covers every address at the contact's domain, and is never
--                  set for a free mail domain.
--   trusted_by     'ai' or 'user', so the owner can see who decided.
ALTER TABLE contacts
  ADD COLUMN trusted_at timestamptz,
  ADD COLUMN trusted_scope text CHECK (trusted_scope IN ('sender','domain')),
  ADD COLUMN trusted_by text CHECK (trusted_by IN ('ai','user'));
CREATE INDEX contacts_trusted_domain ON contacts (account_id, domain_hash) WHERE trusted_scope = 'domain';
