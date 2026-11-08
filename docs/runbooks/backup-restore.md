# Backup and restore

Backups are deployment-defined. For the Docker Compose stack, [`docs/self-hosting.md`](../self-hosting.md#backups) has the commands. `packages/platform/src/__tests__/restore-drill.test.ts` runs a real `pg_dump` and `pg_restore` on local Postgres and proves what's written here. It has never been run against a production database or KMS.

## What a backup contains
- **Encrypted:** message bodies, envelopes, drafts, tasks, analyses, credentials and semantic search vectors.
- **Readable:** search words in `message_search`, unless server search is off, and metadata such as timestamps, labels and risk ratings.
- **Wrapped tenant keys,** in `tenant_keys`. A backup is unreadable without the KMS root key, and fully readable with it. Store the two under separate control.
- **Demo mode only:** `demo_mailbox` holds simulated provider mail in the clear. It stands in for Gmail's own storage and doesn't exist in production data, since demo mailboxes are refused outside demo mode.

## What deletion means for backups
Deleting an account destroys its wrapped keys in the live database. **That doesn't reach backups already taken.** While the root key exists, a backup from before the deletion can still be restored and read, until it expires. So the backup retention period is part of the deletion promise, and has to be stated to the people whose mail you hold. The test named above proves this behavior.

The deletion log below doesn't change that. It re-applies deletions **to a database you restore**. It doesn't reach into a backup file: the file stays readable, by anyone holding it and the root key, until it expires.

To delete from backups sooner you'd need a KMS key per tenant, destroyed at deletion. This build doesn't have that.

## The deletion log
Each durable erasure writes a row to `deletion_outbox`, in the same transaction as the erasure. A `deletion.ship` worker job appends it to the file at `AEGIS_DELETION_LOG_PATH`, syncs the file, and marks the row shipped. Delivery is at least once. An entry's id comes from what it describes, so sending one twice writes one line, and replaying one twice erases once. `tick` queues another job if one is lost, so a row can't be stranded.

An entry holds ids, a kind and a time, and an allowlist enforces that: no addresses, names or subjects. It still says that a given account or message existed and when it was erased, so treat the file as sensitive metadata.

| Kind | Written by | Re-applying it |
|---|---|---|
| `account` | Deleting an account | Same code as the live path, minus re-authentication and provider revocation: mailboxes, rules, notifications, the user's identity, and the keys of personal workspaces |
| `tenant_shred` | The worker destroying a tenant's keys | Destroys the restored wrapped keys. The ciphertext left behind can't be opened, even with the root key |
| `mailbox` | Disconnecting with data deletion, and removing a member (including by SCIM) | Removes the mailbox, its mail and its credential |
| `credential` | Disconnecting and keeping the data | Destroys the credential and marks it disconnected. Otherwise it comes back connected, and syncing |
| `message_sealed` | A client sealing a message | Erases the server's body, search words, vector, stored attachments, tasks and summaries. See the warning below |
| `message_purged` | Retention, and a message deleted at the provider | Tombstones it and erases everything derived from it |
| `search_off`, `vectors_off` | Opting out of server search or semantic search | Erases the words or vectors and turns the preference off |

**A message sealed after the backup loses its ciphertext in a restore.** The ciphertext was only ever in the database, and the log holds no content. The re-apply erases the server's plaintext, so the message comes back with no body here. The provider still has the mail, while the mailbox exists there. A backup taken after the seal keeps the ciphertext, and the re-apply leaves it alone.

**Not covered, because they don't promise erasure, or roll back like any other edit:** a deleted draft, rule or label, a revoked incident share, and a removed member's membership (see step 5). All of them come back with a restore.

### Where to point `AEGIS_DELETION_LOG_PATH`
**A local file only counts as "outside the database" if it's on separate storage.** On the database's own volume, or on a disk that's snapshotted and restored with it, it's lost or rolled back in the same failure that makes you restore, and the deletions in it come back. The file is what makes that promise, so give it what backups get:

- A mount on storage with a different failure domain and different administrators from the database and its backups: a network filesystem in another account or project, for example. It has to support append and `fsync`. An object-store FUSE mount generally doesn't.
- Replicated or backed up off that mount, on a schedule shorter than you'd accept losing, with write-once retention where you have it, and kept at least as long as your longest backup retention.
- Writable only by the worker's identity, readable by whoever runs restores, and never reachable by the web process, which doesn't need it.

A production worker refuses to boot without this setting, like the dev KMS. It can't check any of the above: it sees a path. The operator health page reports whether a worker has a log and is keeping up, and turns red after an hour's backlog.

This build ships only the file sink. `DeletionSink` is a small interface, for a deployment that wants an object store or an external log service instead.

### What the chain can and can't show
Each line holds the hash of the one before it, so a changed line, a removed line, a reordered line or a cut from the start or the middle is found. It has limits, and they're why there are witnesses:

- **Whole lines cut from the end look clean.** So does a chain rewritten from some point on, by someone who can write to the file: the hashes aren't keyed.
- **The restored database is a witness:** it records the sequence and hash of everything shipped before its backup, and the command refuses a log that disagrees. It knows nothing about later lines, which are the ones a restore needs.
- **Your logs are the other witness.** The worker logs `deletion_log.shipped` with `chainSeq` and `chainHash`. Pass the newest to `--expect-head`. That's the only check that covers the most recent lines, so keep those logs apart from the log file.

### Windows it doesn't close
- **Losing the database between commit and ship** loses that entry. Rows normally ship within seconds, but nothing short of writing to the sink inside the transaction closes this, and that would let a sink outage block deletions. A backup taken in that window holds the row, and the command replays it.
- **Backups from before this was deployed** have no entries for earlier deletions. Those deletions aren't in any log.
- **The log is one file with no rotation.** It's small: about 300 bytes a line.
- **A log that's shorter than the database knows, or fails verification, stops shipping.** Rows wait in the outbox and the job fails loudly. Put the intact file back. If there isn't one, keep the broken file, point the setting at a new path, and clear `sink_seq` and `sink_hash` in `deletion_outbox` on the migrating connection. Shipped rows from the last 30 days can be re-shipped by also clearing `shipped_at`. After that, run the restore command once per file. A backup from before the switch records rows from the old file, so its run against the new file needs `--allow-broken-chain`.

## Requirements for a deployment
1. Encrypted backups, with the root key held apart from them.
2. A short documented expiry, published in the privacy policy.
3. A log of deletions on storage separate from the database: `AEGIS_DELETION_LOG_PATH`, above.
4. A quarterly restore drill in an isolated environment.

## Restoring
1. Restore into an isolated database with `pg_restore` (keep ownership: definer functions depend on who owns them).
2. Create the process logins, including one in `aegis_restore_conn`. They're cluster-level, so they aren't in the dump. With the Docker Compose stack, the `logins` step recreates the web and worker logins, and `aegis_restore_login` exists without the right to log in: give it one for the restore with `ALTER ROLE aegis_restore_login LOGIN PASSWORD '...'`, and take it away afterwards with `ALTER ROLE aegis_restore_login NOLOGIN`. The worker image has `pnpm restore:reapply`, so `docker compose run --rm -v <log dir>:/restore-log -e DATABASE_URL_RESTORE=... migrate pnpm restore:reapply /restore-log/deletions.jsonl` runs step 4 there; that hasn't been tried yet. `pnpm db:migrate` applies anything newer, and has to run as a role with `SUPERUSER` or `BYPASSRLS`.
3. Check that a known message opens, using the same KMS.
4. **Re-apply every deletion made since the backup was taken, before anyone can reach it.** Otherwise a restore brings deleted accounts and their mail back. Keep the web process and the worker stopped. Use a copy of the log taken from its storage:
   ```sh
   DATABASE_URL_RESTORE=postgres://your_restore_login@host/db pnpm restore:reapply <log path> --expect-head=<seq>:<hash>
   ```
   `<seq>:<hash>` are `chainSeq` and `chainHash` from the newest `deletion_log.shipped` line in your logs. Without it the command still runs, and prints the head for you to compare yourself.

   It verifies the whole log and checks it against the restored database before it changes anything. If either fails, it exits 2, says which line and why, and applies nothing. It prints counts and never an id, and it warns if anything else is connected. Running it again is safe, and is how to finish a run that died part way. `--verify-only` does the checks and stops.

   **`--allow-broken-chain` is for when no intact copy exists.** It applies every line whose own hash holds, even after a break, and leaves out and reports those that don't. A left-out line is a deletion that wasn't re-applied. A line that's been rewritten along with its hash can't be told from a real one, and will be applied, so record why you used it and find out what happened to the log.

   The login is a member of `aegis_restore_conn`, not the migrating role: it acts as the worker context for tenant data, can scrub a deleted user, can't read a password hash or a TOTP secret, and can't act as a request context. It needs no KMS access, so it can delete mail without being able to read it. Providers aren't called: grants were revoked, or the instructions shown, when the deletion happened.
5. Rotated credentials come back as they were in the backup, so revoke any credential rotated since. Check connected accounts: a mailbox disconnected since the backup stays disconnected after step 4, including one the owner reconnected afterwards, who has to reconnect again. Anyone who turned search back on after opting out has to do that again too. Sessions come back: revoke them all. So do memberships and roles changed since the backup, so re-run SCIM sync or review them, and check for workspaces left with no owner, which happens if the owner deleted their account after handing over ownership and that handover isn't in the backup.

## Restoring into a new cluster
Roles live outside any database, so `pg_dump` alone isn't a complete backup. Back up `pg_dumpall --roles-only` with it, restore those roles first, then run `pg_restore` without `--no-owner`. `infra/local/restore-new-cluster.sh` does this against a fresh local cluster and reads mail through the web login, proving roles, grants, row level security, definer ownership and the key chain all survive. It has never been run against a managed database, where restoring role attributes such as `BYPASSRLS` may need the provider's own tooling.
