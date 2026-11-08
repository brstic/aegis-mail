-- Extracted tasks used the first 40 characters of their text as part of this key, in the clear, while the text itself is encrypted.
-- Old rows get a random suffix: they've been ingested, and messages are deduplicated before tasks are ever written.
UPDATE tasks SET dedupe_key = message_id::text || ':' || gen_random_uuid()::text WHERE source = 'extracted' AND dedupe_key IS NOT NULL;
