# Production requirements

This is what a deployment must provide, and each line is checkable. See `docs/runbooks/deploy.md`.

`infra/terraform/` is one reference deployment on AWS. **It's validated, and has never been applied.** `tofu validate`, `tofu fmt -check` and `tofu test` pass, and the tests check the plan's security properties against a mocked provider. `tofu plan` has never run against AWS because it needs credentials, so nothing here shows AWS would accept it, or that it would work once created. Treat a first apply as a test.

| Requirement | Why | Check |
|---|---|---|
| PostgreSQL 16+ with TLS | `GRANT ... WITH SET` in migration 003 | `SHOW server_version` |
| Separate login roles, members of `aegis_web_conn` and `aegis_worker_conn` | The process boundary only exists if each process has its own login | `process-boundary.test.ts` logic against that database |
| `DATABASE_URL_WEB`, `DATABASE_URL_WORKER`, migration-only `DATABASE_URL` | Boot fails in production without them | Boot |
| A production root of trust: `RootKeyKms` (`AEGIS_ROOT_KEY` or `AEGIS_ROOT_KEY_FILE`, stored apart from database backups) or `AwsKmsProvider` (`AWS_KMS_KEY_ID`) | Boot refuses `LocalDevKms` when `NODE_ENV=production`, a malformed or text-like root key, and both settings at once. `AwsKmsProvider` has only been run against a local server speaking the KMS protocol, never against AWS | Boot |
| Egress firewall on workers: deny private ranges and metadata endpoints; allow 443/993/465/587 | `ssrf.ts` is one layer; the network must be the other | Probe from a worker |
| clamd reachable only from workers, with `AlertExceedsMax yes` (`infra/docker/clamd.conf`) | Without clamd, attachments report "baseline checks only". Without that setting, clamd answers `OK` for a file past its limits that it never read: seen with real clamd | Privacy Center row; `clamd.live.test.ts` |
| Backups encrypted, expiry documented, restore tested | Deletion semantics depend on backup expiry | `docs/runbooks/backup-restore.md` drill |
| `AEGIS_DELETION_LOG_PATH` on the worker, on storage separate from the database, plus a login in `aegis_restore_conn` for restores | A restore re-applies deletions from it. Boot refuses a production worker without it, but can't tell if the storage is really separate | Boot, then the operator health page |
| Log pipeline retains only the JSON fields `log.ts` allows | Content-free logging | Spot check |
| `DEMO_MODE` unset | Disables seeded logins and synthetic mailboxes | `/api/v1/public/config` |

## The reference deployment

`infra/terraform/reference` wires five modules: `network`, `kms`, `database`, `secrets`, `compute`. To check it, with no AWS account:

```sh
cd infra/terraform/reference
tofu init -backend=false
tofu validate
tofu fmt -check -recursive ..
tofu test
```

What it covers against the table above:

| Requirement | How | Gap |
|---|---|---|
| PostgreSQL with TLS | RDS, `rds.force_ssl=1`, encrypted, private, multi-AZ | The server only insists on TLS. Clients must verify it: use `sslmode=verify-full&sslrootcert=...` in the connection strings, and add the RDS CA bundle to the images, which the Dockerfile doesn't yet do |
| Separate logins | Secrets are handed out per process: `tofu test` checks web, worker and migration each get only their own | You create the logins, below |
| Real KMS | A key per purpose. The app key has no root statement, administrators can't decrypt, and wrapping requires an encryption context | `AwsKmsProvider` has never been run against AWS: treat the first boot against this key as a test |
| Worker egress | Security group allowlist of ports, plus a network ACL denying private ranges ahead of any public allow | See the note on metadata |
| clamd | Separate service in its own subnets, reachable only from the worker security group. Build the image from the `clamd` target | One task, so clamd restarting means attachments report an error for that time |
| Backups | RDS automated backups, 14 days by default, and a final snapshot | State the same number to your users. Restore has never been drilled on this |
| Deletion log | An encrypted EFS volume mounted on the worker, reachable only from the worker security group | In the same AWS account, so an account-level compromise reaches it and the database together. Copy it to another account with AWS Backup. Never applied |
| Logs | CloudWatch, encrypted, 30 days by default. Statement logging stays off | |
| `DEMO_MODE` unset | Never set, and `tofu test` refuses it in `extra_environment` | |

Not covered: alarms, a WAF, and building or pushing images.

**Metadata endpoints can't be denied here.** AWS doesn't apply security groups or network ACLs to the instance or task metadata addresses, so the `169.254.0.0/16` deny rule documents intent and enforces nothing. Fargate has no instance metadata service, but the task metadata address (`169.254.170.2`) stays reachable and can hand out the task role's credentials. `ssrf.ts` refuses that range, and it's the only layer that does. A real second layer needs a different compute option, or a forward proxy.

### First apply, in order

1. Build and push the three image targets. Then `tofu init` with your backend, and `tofu apply` with your own `tfvars`, and read the plan first.
2. Using the master credential from `database_master_secret_arn`, create a migration owner and the two process logins. Migrations create the `*_conn` roles, so run them first as the migration login, then the `GRANT`s:

   ```sql
   CREATE ROLE aegis_migrator LOGIN CREATEROLE PASSWORD :'migrator_password';
   GRANT rds_superuser TO aegis_migrator;
   -- after the migration task has run:
   CREATE ROLE aegis_web_prod LOGIN PASSWORD :'web_password' IN ROLE aegis_web_conn;
   CREATE ROLE aegis_worker_prod LOGIN PASSWORD :'worker_password' IN ROLE aegis_worker_conn;
   ```

   `pnpm db:migrate` leaves logins to you when `NODE_ENV=production` and `DEMO_MODE` is unset.
3. Put the three connection strings in Secrets Manager under `secret_arns`. A task can't start while a secret it names has no value.
4. Run `migrate_task_definition` in the worker subnets with the worker security group. Then let the services start.
5. Probe from a worker: a private address must time out, and a public one on an allowed port must connect.
