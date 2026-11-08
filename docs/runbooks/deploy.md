# Deploy

For most people, the Docker Compose stack in [`docs/self-hosting.md`](../self-hosting.md) is the way to deploy, and does steps 2, 3 and 5 below for you. This runbook is the same sequence for any other platform, such as Kubernetes or a managed container service with a managed PostgreSQL. `infra/terraform/reference` is one such deployment on AWS, validated but never applied: see `infra/environments/production/README.md`.

1. Read `infra/environments/production/README.md`. Every row must hold. `LocalDevKms` can't boot in production, so a root key (`AEGIS_ROOT_KEY`/`AEGIS_ROOT_KEY_FILE`) or AWS KMS (`AWS_KMS_KEY_ID`) is a prerequisite.
2. Run migrations with `DATABASE_URL`, using a role that can create roles (see below). Migrations serialize on an advisory lock.
3. Create logins: `CREATE ROLE web_login LOGIN PASSWORD '...' IN ROLE aegis_web_conn;` and likewise for the worker in `aegis_worker_conn` (the groups exist once migrations have run), and for the restore operator in `aegis_restore_conn`, which no running process uses. Keep the migration credential out of the running processes.
4. Optionally, run `pnpm operators sync` with `AEGIS_PLATFORM_ADMINS` set, using `DATABASE_URL`. See `docs/runbooks/operators.md`.
5. Mount storage separate from the database, and set `AEGIS_DELETION_LOG_PATH` on the worker. It refuses to boot without it. See `docs/runbooks/backup-restore.md`.
6. Deploy worker, then web. Check `/api/v1/health`, then that `/api/v1/public/config` shows `demoMode: false`.
7. Run `docs/runbooks/live-provider-smoke-test.md` against a test mailbox.

Rollback: migrations are forward-only. Take a snapshot before migrating, and redeploy the prior image; schema changes must stay backward compatible for one release.

## The migrating role
Run migrations as a role with `SUPERUSER` or `BYPASSRLS`, kept separate from every application login. Definer functions such as `app.can_access_account` read tables with forced row level security and run as their owner, so an owner subject to RLS gets empty results instead of an error: access checks fail closed and webhook lookups find nothing. `migrate` refuses to run under any other role. On a managed Postgres without superuser, grant `BYPASSRLS` to the migration role if the provider allows it. No application process may ever log in as this role.
