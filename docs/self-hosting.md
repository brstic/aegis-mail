# Self-hosting

This guide runs Aegis Mail for real mail on your own server, with Docker Compose. For a quick look with synthetic mail, run `docker compose -f infra/docker/compose.yml up --build` on your own machine instead and open http://localhost:3000. That demo stack has public logins and a public key, so never expose it.

Before you put real mail on an instance, read [`STATUS.md`](STATUS.md). In short: the code paths for Gmail, Microsoft Graph, AWS KMS (optional) and SMTP relays have been tested against protocol fakes and local servers, not the live services, and the production stack below has been validated as configuration but not yet run end to end in containers.

## What you need
| | Why |
|---|---|
| A Linux server, x86_64 or arm64, with Docker and Docker Compose v2 | The images build on both. Plan for about 8 GB of memory: ClamAV alone uses up to 3 GB, and the web and worker images are large (about 4.4 GB on disk, since they keep their build tooling) |
| A domain name and a TLS reverse proxy | Session cookies are `Secure`, and passkeys need a stable host name. See [Reverse proxy and TLS](#reverse-proxy-and-tls) |
| A root key | Message content is encrypted under per-workspace keys, which are wrapped by one root key. You generate it with `openssl rand -base64 32`; AWS KMS can hold it instead. **Outside demo mode, the app refuses to start without one.** See [The root key](#the-root-key) |
| An SMTP relay (strongly recommended) | Address verification, password reset, invitations and digests. Without one, those flows say they're unavailable, and nobody can verify their address, which inviting people requires |
| OAuth clients for Gmail or Microsoft (optional) | Only for those providers. IMAP and SMTP mailboxes need nothing on the server |
| An Anthropic API key (optional) | Hosted-model summaries, drafts and a second opinion on suspicious mail. Without it, local rules do this, and nothing leaves your server |

## Install
```sh
git clone https://github.com/brstic/aegis-mail.git && cd aegis-mail
cp infra/docker/selfhost.env.example .env && chmod 600 .env
```

Fill in `.env`. The required settings are `APP_ORIGIN`, `WEBAUTHN_RP_ID`, `POSTGRES_PASSWORD`, `AEGIS_WEB_DB_PASSWORD`, `AEGIS_WORKER_DB_PASSWORD` and `AEGIS_ROOT_KEY` (or AWS KMS instead: see [The root key](#the-root-key)). Compose stops with a message naming any of the first five that's missing, and web and worker refuse to start without a root key. Generate the passwords with `openssl rand -hex 32`: they go into connection URLs, so keep them URL-safe. Then:

```sh
docker compose up -d --build
docker compose ps
```

[`compose.yaml`](../compose.yaml) starts these, in order:

| Service | What it does |
|---|---|
| `db` | PostgreSQL 17, in the `dbdata` volume. No port is published |
| `clamd` | ClamAV, built from `infra/docker/Dockerfile` with `infra/docker/clamd.conf`. The first start downloads signatures, which takes a few minutes, and web and worker wait for it |
| `migrate` | Runs `pnpm db:migrate` as the database owner, then exits. It's the only container with the owner's password |
| `logins` | Creates the `aegis_web_login` and `aegis_worker_login` roles if needed and sets their passwords from `.env`, then exits. It also creates `aegis_restore_login` without the right to log in, for restores |
| `volumes-init` | Hands the deletion-log and model volumes to the unprivileged user the images run as, then exits |
| `web` | The UI and API on port 3000, published on `127.0.0.1:3000` by default. Logs in as `aegis_web_login`, which can't read mailbox credentials |
| `worker` | Sync, analysis, sending, retention and the deletion log. Logs in as `aegis_worker_login` |

When `docker compose ps` shows `web` healthy, `curl -s http://127.0.0.1:3000/api/v1/health` answers `{"ok":true}`, and `curl -s http://127.0.0.1:3000/api/v1/public/config` shows `"demoMode":false`.

### The first user
1. Open your `APP_ORIGIN` and choose **Sign up**. Pick a personal workspace or an organization: you become its owner. On an empty server the first account can always sign up.
2. Confirm your address from the email. This needs the SMTP relay.
3. Under Settings, Security, add an authenticator app or a passkey, and save the recovery codes.
4. In an organization, invite people from the Organization pages.

After that, sign-up is by invitation (`AEGIS_SIGNUP=invite`, the default): only an address with a pending invitation can create an account, with a password or with Google or Microsoft sign-in. Set `AEGIS_SIGNUP=open` to let anyone who can reach the server sign up; each new account then gets its own workspace. Single sign-on and SCIM set up by an organization add their own people either way.

### Platform operators (optional)
An operator console at `/admin` lets the people running the instance see workspaces, suspend one, retry failed jobs and read the operator audit log, without any access to mail. You don't need it to use the app. See [`runbooks/operators.md`](runbooks/operators.md).

## The root key
Each workspace has its own keys, stored in the database wrapped by one root key, so a database dump alone can't be read. Deleting a workspace destroys its keys, which is what makes deletion final ("crypto-shredding"), with the limits for backups described in [`runbooks/backup-restore.md`](runbooks/backup-restore.md). There are two ways to hold the root key.

### A key you generate (the default)
```sh
openssl rand -base64 32
```
Put the result in `AEGIS_ROOT_KEY` in `.env`, or in a file whose path you set as `AEGIS_ROOT_KEY_FILE` (for example a Docker secret). The app refuses a key that isn't 32 random bytes, so a placeholder can't slip through.

- **Back it up apart from your database backups**, for example in a password manager. Without it, stored mail can't be decrypted, and a backup is only as safe as the place the key isn't.
- **Never change it** on an instance that has data: data wrapped by the old key becomes unreadable. Re-keying isn't implemented yet.
- Anyone who can read `.env` on the server can read the key, so keep the file `chmod 600` and limit who has shell access. If that isn't enough for you, use AWS KMS.

### AWS KMS (alternative)
With KMS, the root key never leaves AWS: the server can ask KMS to unwrap workspace keys, but it never holds the root key itself. Leave `AEGIS_ROOT_KEY` empty; setting both is refused.

1. In AWS KMS, create a **symmetric** key for encrypt and decrypt, in the region you'll set as `AWS_REGION`.
2. Give the identity the containers use permission for `kms:Encrypt` and `kms:Decrypt` on that key. The app always sends the encryption context key `aegis`, so you can require it with the condition `"Null": {"kms:EncryptionContext:aegis": "false"}`.
3. Set `AWS_KMS_KEY_ID` to the key's ARN. For credentials, either set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for an IAM user limited to the step above, or leave them empty on a host where the AWS SDK finds credentials itself, such as an EC2 instance role.

Anyone with both a dump and use of the KMS key can read it, so keep the two under different control.

`AwsKmsProvider` has been tested against a local server speaking the KMS protocol, never against AWS itself, so treat the first start as a test: check the worker's log, and that a sign-up succeeds. The AWS SDK also honours `AWS_ENDPOINT_URL_KMS`, for an endpoint that speaks the same protocol: add it to the `x-app-env` block in `compose.yaml` if you use one. Other KMS or HSM backends would need a new `KmsProvider` in `packages/cryptography`.

## Reverse proxy and TLS
The web container speaks plain HTTP on `127.0.0.1:3000`. Terminate TLS in front of it:

- `APP_ORIGIN` must be exactly the `https://` address people use, with no trailing slash, and `WEBAUTHN_RP_ID` its host name. Requests whose `Origin` doesn't match `APP_ORIGIN` are refused, and OAuth redirect URIs are built from it.
- Pass the `Host` header through, and set `X-Forwarded-For` to the client's address. The app reads the last address in that header for rate limiting, so the proxy must append to it or overwrite it.
- Allow request bodies up to 100 MB: client-side sealing uploads a whole message.
- Don't cache `/api/`.

With Caddy, which fetches certificates for you:

```
mail.example.com {
	reverse_proxy 127.0.0.1:3000
	request_body {
		max_size 100MB
	}
}
```

With nginx:

```nginx
server {
  listen 443 ssl;
  server_name mail.example.com;
  # ssl_certificate and ssl_certificate_key as usual
  client_max_body_size 100m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

Leave `/api/v1/webhooks/*` and `/api/v1/scim/*` reachable without any extra authentication at the proxy if you use push notifications or SCIM: they carry their own.

**Restrict outbound traffic from the worker** if you can. It connects to mail servers the users choose, and `ssrf.ts` refuses private, loopback and metadata addresses, but a network-level rule is the second layer: allow outbound 443 and the mail ports your users need (IMAP 993 and 143, POP3 995 and 110, SMTP 465, 587, 25 and 2525, the same list the app enforces), and deny private ranges.

## Connecting mailboxes
**IMAP and SMTP** (iCloud, Fastmail, Yahoo, your own server): nothing to configure. Users choose Connect in the app and enter an app password. iCloud has a guided setup.

**Gmail.**
1. In Google Cloud, create a project, enable the Gmail API, and configure the OAuth consent screen. In **Testing** status it works without Google's review for up to 100 test users that you list. Using Gmail's restricted scopes beyond that needs Google's verification, including a security assessment.
2. Create an OAuth client of type **Web application** with the redirect URI `<APP_ORIGIN>/api/v1/oauth/gmail/callback`.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The app asks for `https://www.googleapis.com/auth/gmail.modify`, or `gmail.readonly` when a user connects read-only.
4. Optional push, instead of polling: create a Pub/Sub topic, grant `gmail-api-push@system.gserviceaccount.com` the Publisher role on it, and create a push subscription to `<APP_ORIGIN>/api/v1/webhooks/gmail` with authentication turned on, using a service account you create for it. Set `GOOGLE_PUBSUB_TOPIC` (`projects/<project>/topics/<topic>`), `GOOGLE_PUBSUB_AUDIENCE` (the audience on the subscription) and `GOOGLE_PUBSUB_SERVICE_ACCOUNT` (that service account's email). Tokens from any other account are refused.

**Outlook and Microsoft 365.**
1. In Microsoft Entra, register an application for accounts in any organizational directory and personal Microsoft accounts. Add a **Web** platform with the redirect URI `<APP_ORIGIN>/api/v1/oauth/microsoft/callback`.
2. Add the delegated Microsoft Graph permissions `Mail.ReadWrite`, `Mail.Send`, `offline_access` and `User.Read` (`Mail.Read` is used for read-only connections). Create a client secret.
3. Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`.
4. Optional change notifications, instead of polling: set `MICROSOFT_WEBHOOK_URL` to `<APP_ORIGIN>/api/v1/webhooks/graph`.

Restart after changing any of these: `docker compose up -d`.

### Signing in with Google, Microsoft or your identity provider
"Continue with Google" and "Continue with Microsoft" on the sign-in page use separate OAuth clients that ask only for identity (`openid email profile`), never mail. Register them with the redirect URI `<APP_ORIGIN>/api/v1/auth/sso/callback` and set `SIGNIN_GOOGLE_*` or `SIGNIN_MICROSOFT_*`. For Microsoft, add the `xms_edov` optional claim to the ID token, or nobody can create an account through it. An account is never linked to an existing one by email address.

Organizations configure their own OIDC or SAML single sign-on and SCIM provisioning in the app, under Organization, SSO, after verifying their domain with a DNS record. The page shows the URLs to give the identity provider.

## Configuration reference
Set these in `.env`. `compose.yaml` passes each one to the services that use it, and sets `NODE_ENV=production`, `DEMO_MODE=false`, the database URLs, `CLAMD_HOST` and the deletion log path itself.

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `APP_ORIGIN` | required | web, worker | Public `https://` address, no trailing slash. Links in email and OAuth redirect URIs are built from it |
| `WEBAUTHN_RP_ID` | required | web | Host name of `APP_ORIGIN`, for passkeys. Changing it later invalidates registered passkeys |
| `POSTGRES_PASSWORD` | required | db, migrate, logins | Password of the database owner, `postgres` |
| `AEGIS_WEB_DB_PASSWORD`, `AEGIS_WORKER_DB_PASSWORD` | required | web, worker, logins | Passwords of the two process logins |
| `AEGIS_ROOT_KEY` | required, unless one of the next two is set | web, worker | 32 random bytes, base64 (`openssl rand -base64 32`). Wraps every workspace key. Back it up separately and never change it |
| `AEGIS_ROOT_KEY_FILE` | empty | web, worker | Path to a file holding the root key instead, such as a Docker secret |
| `AWS_KMS_KEY_ID` | empty | web, worker | ARN of an AWS KMS key that holds the root instead. Can't be combined with `AEGIS_ROOT_KEY` |
| `AWS_REGION` | empty | web, worker | Region of that key |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | empty | web, worker | Static credentials for KMS. Empty uses the SDK's other sources |
| `TRANSACTIONAL_SMTP_URL` | empty | web, worker | `smtps://user:pass@host:465` or `smtp://user:pass@host:587`. TLS is required, with certificate checks, unless the relay is on the same machine |
| `TRANSACTIONAL_FROM` | empty | web, worker | Sender of that mail, such as `Aegis Mail <no-reply@example.com>`. Both this and the URL are needed |
| `AEGIS_DELETION_LOG_DIR` | Docker volume `deletionlog` | worker | Host directory for the deletion log. Use storage separate from the database's: see [Backups](#backups) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | empty | web, worker | Gmail mailbox connections |
| `GOOGLE_PUBSUB_TOPIC`, `GOOGLE_PUBSUB_AUDIENCE`, `GOOGLE_PUBSUB_SERVICE_ACCOUNT` | empty | web, worker | Gmail push. All three, or none |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | empty | web, worker | Outlook and Microsoft 365 mailbox connections |
| `MICROSOFT_WEBHOOK_URL` | empty | worker | `<APP_ORIGIN>/api/v1/webhooks/graph`, for Graph change notifications |
| `SIGNIN_GOOGLE_CLIENT_ID`, `SIGNIN_GOOGLE_CLIENT_SECRET` | empty | web | "Continue with Google" |
| `SIGNIN_MICROSOFT_CLIENT_ID`, `SIGNIN_MICROSOFT_CLIENT_SECRET` | empty | web | "Continue with Microsoft" |
| `ANTHROPIC_API_KEY` | empty | web, worker | Hosted model. Each user must also turn it on, in the Privacy Center |
| `AEGIS_LLM_MODEL` | `claude-opus-5-5` | web, worker | Model name for the hosted model |
| `AEGIS_LLM_BASE_URL` | empty | web, worker | An Anthropic-compatible endpoint to use instead of Anthropic's |
| `AEGIS_EMBEDDINGS` | empty | web, worker | `local` turns on semantic search. A small model (about 23 MB, `Xenova/all-MiniLM-L6-v2`) downloads once from huggingface.co into the `models` volume and runs inside web and worker. No mail leaves the server |
| `AEGIS_REGION` | empty | web | Shown in the Privacy Center as where data is processed |
| `AEGIS_SIGNUP` | `invite` | web | `invite`: the first account, then only addresses with a pending invitation. `open`: anyone who can reach the server. Any other value counts as `invite` |
| `AEGIS_LIMIT_ACCOUNTS`, `AEGIS_LIMIT_AI_ACTIONS_PER_MONTH`, `AEGIS_LIMIT_AUTOMATIONS`, `AEGIS_LIMIT_SEATS`, `AEGIS_LIMIT_INDEX_BYTES` | empty (no limit) | web, worker | Optional limits for every workspace: connected mailboxes, hosted-model actions a month, automations, members, and search index size in bytes. A whole number of zero or more; anything else stops the server from starting. The operator console can set a different value per workspace |
| `AEGIS_MARKETING_SITE` | `false` | web | `true` shows the public product site at `/` and its pages. Anything else sends `/` and those pages to sign-in, or into the app for someone signed in, which is what a self-hosted instance wants |
| `AEGIS_PLATFORM_ADMINS` | empty | migrate | Comma-separated operator addresses, applied by `pnpm operators sync` |
| `AEGIS_METRICS_TOKEN` | empty | web | Bearer token for the Prometheus-format `/api/v1/metrics`. Empty keeps the endpoint off. It reports queue depth, never content |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty | worker | OpenTelemetry trace export. Span attributes are allowlisted and carry no content |
| `WORKER_CONCURRENCY` | `4` | worker | Jobs run at once, and threads for message analysis |
| `AEGIS_WEB_BIND`, `AEGIS_WEB_PORT` | `127.0.0.1`, `3000` | compose | Where the web port is published on the host |

For development outside Docker, [`.env.example`](../.env.example) lists the same settings with development defaults, plus `DATABASE_URL`, `DATABASE_URL_WEB`, `DATABASE_URL_WORKER`, `DATABASE_URL_RESTORE`, `AEGIS_DEV_ROOT_KEY` and the semantic search model paths.

## Backups
Back up three things, and keep each apart from the others:

1. **The database**, with its roles, which live outside any one database:
   ```sh
   docker compose exec -T db pg_dumpall -U postgres --roles-only > roles.sql
   docker compose exec -T db pg_dump -U postgres -Fc aegis > aegis.dump
   ```
   Mail content in the dump is encrypted. Search words (unless server search is off) and metadata such as dates and labels are not.
2. **The deletion log**, the `deletionlog` volume or your `AEGIS_DELETION_LOG_DIR`. It lets a restore re-apply deletions made after the backup was taken, so deleted accounts don't come back. Keep it on different storage from the database. A worker outside demo mode refuses to start without it.
3. **`.env`**, which holds the database passwords and the root key (or the KMS key's ARN). Keep this copy apart from the database backups: a dump plus the root key is readable mail. With AWS KMS, the key itself stays in KMS: never schedule its deletion while any backup you might restore still exists.

Restoring, including re-applying the deletion log with `pnpm restore:reapply` before anyone can reach the restored data, is in [`runbooks/backup-restore.md`](runbooks/backup-restore.md). Decide how long backups are kept: it's part of what deletion means for your users.

## Upgrades
```sh
docker compose exec -T db pg_dump -U postgres -Fc aegis > before-upgrade.dump
git pull
docker compose up -d --build
```

`migrate` runs on every start and applies only new migrations. Migrations are forward-only: to roll back, restore the dump and check out the previous version. Read the release notes for anything that needs a manual step.

## Operating
- Logs: `docker compose logs -f web worker`. Logs are JSON lines with an allowlist of fields, and carry no mail content.
- Health: `/api/v1/health` checks the database. The operator console's health page also reports the job queue and whether the deletion log is keeping up.
- Restart: `docker compose restart web worker`. Containers come back with the host.
- Stop: `docker compose down`. Add `-v` only if you mean to delete all data.

## Demo mode
`DEMO_MODE=true` seeds a workspace with synthetic mail, adds public demo logins, shows outgoing mail at `/dev/outbox` instead of sending it, and allows the development key provider. **Never use it with real mail or real people.** `infra/docker/compose.yml` runs it locally. `infra/docker/compose.staging.yml`, with `infra/docker/staging-env.sh`, runs it on a server behind a reverse proxy, for a public demo: put a password gate in front of it.
