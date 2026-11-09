# Platform operators

Operators are the people running an instance, separate from any workspace role. The console at `/admin` lists workspaces, suspends and restores them, shows the job queue and retries failed jobs, reports instance health (including the deletion log), and keeps an operator audit log. `/admin` and `/api/v1/operator/*` return 404 for everyone else, signed in or not. A self-hosted instance doesn't need an operator to work.

## Granting access
1. Have the person create an ordinary account, verify its email address, and turn on an authenticator app or register a passkey.
2. Grant it on the migrating connection, which only the `migrate` container has. Either list addresses in `AEGIS_PLATFORM_ADMINS` and run `pnpm operators sync`, or grant one directly:
   ```sh
   docker compose run --rm migrate pnpm operators grant person@example.com
   docker compose run --rm migrate pnpm operators list
   ```
   `revoke <email>` removes access. Removing an address from `AEGIS_PLATFORM_ADMINS` takes effect at the next `sync`. **No web or worker login can grant access**, which is why this never happens at web start.
3. A grant binds to the account's user ID and refuses an unverified address, so signing up with a listed address gains nothing. Check that the output says what you expect.
4. Outside demo mode, `/admin` also needs the current session to have presented a second factor: a code at sign-in, or a sign-in with a passkey. Turning on an authenticator app counts only for a session that typed the password to start it, and a passkey added on the strength of a recent sign-in counts only after 7 days. A demo-seeded operator is refused outside demo mode.

The CLI reads the same root key settings as web and worker (`AEGIS_ROOT_KEY`, `AEGIS_ROOT_KEY_FILE` or `AWS_KMS_KEY_ID`), so it starts under `NODE_ENV=production`; make sure the `migrate` container gets them.

## Verifying an address without a mail relay
An install with no SMTP relay can't send the verification link, so the "email isn't verified" banner would never clear. Two things clear it:
- Connecting the **Gmail** mailbox for the sign-in address verifies the account on the spot, because Google only issues a token for an address to its owner. Microsoft mailboxes don't count: the address Graph reports can be set by that tenant's own administrator.
- From a shell on the server:
  ```sh
  pnpm operators verify person@example.com
  ```
  It's recorded in the audit log as `auth.email_verified` with the reason `operator_cli`.

## What operators can't do, by construction
Read mail, subjects, senders or mailbox addresses, act as a user, or export workspace data. Their database role, `aegis_operator`, has no table grants. It can only call `op.*` functions, and the role that owns those has column-level grants that exclude content. The one exception is deliberate: "owner contact" returns one owner's name and address, needs a reason, and is recorded in the operator log and in the workspace's own audit log. Someone with deploy rights or database superuser access isn't constrained by any of this: see "Mode A" in `docs/STATUS.md`.

**Suspending a workspace** blocks sign-in and sessions, stops sync, makes sends and deletions wait, and deletes nothing. Someone who also belongs to another workspace can still reach that one. The reason is shown at sign-in, so write it for the people in that workspace to read.

**The operator audit log** can't be changed through operator access or by the role that writes it, and a trigger stops the table owner's UPDATE and DELETE too. A superuser could disable the trigger. Ship the log elsewhere if you need tamper evidence against that.
