# Security policy

## Reporting a vulnerability
Please report vulnerabilities privately, through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (https://github.com/brstic/aegis-mail/security/advisories/new). Don't open a public issue, pull request or discussion for a security problem.

Include what you found, the version or commit, how to reproduce it, and what an attacker could do with it. A working proof helps, as long as it uses your own accounts and data.

This is a volunteer project with no bug bounty. We'll acknowledge your report, keep you informed while we fix it, and credit you in the advisory unless you'd rather not be named.

## Scope
In scope: the code in this repository, including the web app and API, the worker, the database migrations and roles, the encryption code, the Docker and Compose files, and the browser extension. Of particular interest:
- reading another person's or another workspace's mail, or mailbox credentials;
- a workspace admin or a platform operator reading members' mail;
- getting past sign-in, a second factor, SSO or SCIM;
- mail that escapes the sanitizer or the sandboxed viewer, or makes the server fetch an internal address;
- a message, link or attachment that makes the AI act on its own instructions, or reach a send, forward or delete action;
- anything that would make a restore bring deleted data back without the documented limits.

Out of scope: an instance someone else runs and its configuration, problems in third-party services such as Gmail or AWS, phishing that the detection engine misses (open a normal issue with a synthetic sample instead), and anything that needs demo mode, which is public by design.

## Supported versions
Only the latest commit on `main` gets security fixes.

## Running it safely
The known limits of the design, what has and hasn't been tested, and how to deploy it are in [`docs/STATUS.md`](docs/STATUS.md), [`docs/threat-model/README.md`](docs/threat-model/README.md) and [`docs/self-hosting.md`](docs/self-hosting.md). In particular, never run with `DEMO_MODE=true` on an instance that holds real mail.
