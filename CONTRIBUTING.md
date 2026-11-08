# Contributing

Thanks for helping. Bug reports, fixes, tests against real providers and documentation are all welcome. To report a security problem, don't open an issue: see [SECURITY.md](SECURITY.md).

By contributing, you agree that your contribution is licensed under the [AGPL-3.0](LICENSE), like the rest of the project.

## Setup
You need Node 22 or newer (CI uses 24), pnpm 9 (`corepack enable` picks the version in `package.json`), and PostgreSQL 16 or newer on localhost that your OS user can connect to without a password.

```sh
cp .env.example .env
pnpm bootstrap   # install, create aegis_dev, migrate, seed the synthetic demo workspace
pnpm dev         # web on http://localhost:3000, and the worker
```

Sign in with **Try the demo** on the sign-in page. Demo mode runs the real pipeline over synthetic mailboxes, so most work needs no external account. `/dev/outbox` shows mail the app would have sent.

## Checks
Run these before opening a pull request. CI runs the same on every pull request.

```sh
pnpm typecheck   # every package
pnpm test        # vitest: unit, integration, contract and security tests
pnpm test:e2e    # Playwright against a production build of apps/web, with the real worker
pnpm eval        # detection evaluation; required when you change a detector or a weight
```

- `pnpm test` creates and drops its own `aegis_test_*` databases, so it needs Postgres but leaves `aegis_dev` alone. Suites run one file at a time.
- `pnpm test:e2e` builds into its own directory and uses an `aegis_e2e` database. First run `pnpm --filter @aegis/web exec playwright install chromium`. Visual baselines are committed for macOS; elsewhere, add `--ignore-snapshots`, as CI does.
- `*.live.test.ts` suites run against real servers (clamd, Dovecot, Postfix, a KMS emulator) and are skipped unless their environment variables are set. `infra/local/live-servers.sh` starts the servers and prints the variables.
- The browser extension has its own tests: `pnpm --filter @aegis/extension test`.

## Conventions
- **TypeScript everywhere**, run directly with `tsx`; there's no build step for packages. `pnpm typecheck` must be clean.
- **Tests sit next to the code** (`foo.ts`, `foo.test.ts`), or in `packages/platform/src/__tests__` for tests that cross packages. A fix comes with a test that fails without it. Security fixes go in the `review-regressions*` suites.
- **Database changes are new numbered migrations** in `packages/db/migrations` (`NNN_name.sql`). Never edit one that's already there: they are forward-only. Mail tables need row-level security and a test in `tenant-isolation.test.ts` or `process-boundary.test.ts`.
- **API contracts are zod schemas** in `packages/domain`. After changing one, run `pnpm openapi` to regenerate `docs/openapi.json`.
- **No mail content in logs, job payloads or telemetry.** `log.ts` drops any field not on its allowlist, and jobs carry IDs only; tests enforce both.
- **Mail is untrusted input**, to the parser, the renderer and any model. The model never gets a tool that sends, forwards or deletes.
- **Security runs before priority.** Nothing in ranking may lower a security rating.
- **Say only what's true.** Every claim in the UI or the docs needs code and a test behind it. When you change what works, or what something has been tested against, update [`docs/STATUS.md`](docs/STATUS.md). Record significant design decisions in [`docs/adr/README.md`](docs/adr/README.md).
- **Write in English**, in plain sentences.
- `apps/web` uses a recent Next.js with breaking changes: read `apps/web/AGENTS.md` before changing it.

## Pull requests
Keep each pull request to one change, describe what it does and how you tested it, and say if anything was tested only against fakes. Contributions that connect the code to a real Gmail, Microsoft, iCloud or KMS account are especially useful: follow [`docs/runbooks/live-provider-smoke-test.md`](docs/runbooks/live-provider-smoke-test.md) and record the result.
