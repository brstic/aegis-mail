-- Period-named job keys are looked up after the job has finished, which the partial unique index doesn't cover.
CREATE INDEX jobs_dedupe_any ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL;
