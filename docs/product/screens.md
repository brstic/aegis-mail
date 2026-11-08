# Screen specifications

Shared behaviour for all signed-in screens: skeleton while loading; `ErrorState` for offline, 403, 404, and 5xx; banners for disconnected and partial-sync; keyboard map in the `?` dialog; a mobile drawer below `lg`; targets WCAG 2.2 AA, checked by `apps/web/e2e/a11y.spec.ts`.

| Screen | User goal | Primary action | Key dependencies | Success measure |
|---|---|---|---|---|
| Focus `/app/focus` | See what needs me, and why | Open top item | `GET /focus`, `/digest` | Time to first action; corrections rate |
| Inbox `/app/inbox` | Everything, in order | Open or archive | `GET /threads?view=inbox` | Parity with provider |
| Account `/app/inbox?account=` | One mailbox only | Open | same, `accountId` | Correct scoping |
| Search `/app/search` | Find a message | Refine | `GET /threads?q=&concepts=`, preferences for saved searches | Result in first page |
| Thread `?t=` | Read safely, act | Reply | `GET /threads/:id` | No remote fetch; identity shown |
| Composer | Write from the right identity | Send | `/drafts`, `/drafts/:id/attachments`, `/drafts/:id/send` | No wrong-identity sends |
| Labels `/app/labels` | Sort mail my way | Create | `GET/POST/DELETE /labels`, `POST /threads/:id/actions` | Label applied from a thread or selection |
| Insights `/app/insights` | Understand my own mail habits | Change period | `GET /insights` | No content shown |
| Security report `/app/security-report/:messageId` | See exactly why a message was rated | Print | `GET /threads/:id` | Reason codes, evidence, provenance |
| Topics `/app/settings/topics` | Tag new mail my way | Add a topic | `PATCH /preferences` | Applies to new mail |
| Signatures and addresses `/app/settings/identity` | Control how mail signs off and where it's from | Add a signature | `PATCH /preferences`, `PATCH /accounts/:id` | Only listed addresses send |
| Design system `/design-system` | See the real components and tokens | Browse | none | Contrast passes in both themes |
| Quarantine | Decide on held mail | Release or delete | `/messages/:id/quarantine` | Time to decision; false-positive recovery |
| Tasks | Track asks and promises | Mark done | `/tasks` | Completion |
| Rules | Automate safely | Save after dry run | `/automations/*` | Dry run before enable |
| Privacy Center | Know who can read what | Change a control | `/privacy` | Comprehension |
| Security Center | Team risk, with no content | Tune policy | `/org/security` | No content exposed |
| Organization | Run the workspace | Invite, set policy | `/org/*` | Role correctness |
| Connect | Add a mailbox | Connect | `/oauth/*`, `/accounts/imap` | Connection success |
| Onboarding | First value in five minutes | Connect | several | First Focus success |
| Safe link | Check before clicking | Continue or stay | `/links/inspect` | Lookalike warnings shown |
| Public pages, shown with `AEGIS_MARKETING_SITE=true` | Understand and trust | Try the demo | none | Sign-up |

## Keyboard map
`j/k` or arrows move · `o`/`Enter` open · `u` back · `Esc` closes what's open, or goes back · `e` archive · `#` trash · `s` star · `Shift+u` unread · `l` labels · `x` select · `c` compose · `r` reply · `f` forward · `/` search · `i` intelligence panel · `a` assistant · `g f`/`g i`/`g q`/`g s`/`g d`/`g t`/`g l` go to · `?` help.

The list lives in `apps/web/src/lib/shortcuts.ts`, which feeds both the `?` dialog and `/design-system`.

## System states
| State | Where it appears |
|---|---|
| Empty inbox, partial sync, offline, disconnected | Mail views and shell banners |
| OAuth not configured or unverified | Connect screen |
| Unsupported provider | Manual setup (Proton) |
| TLS failure, auth failure | Manual setup troubleshooting by `error.code` |
| SMTP rejection | Draft `failed` state, a toast when it happens, a count on Drafts in the sidebar |
| Unscannable attachment | Security strip, "Couldn't verify" |
| Scanner unavailable | Attachment row and Privacy Center |
| Suspicious link | Safe-link interstitial |
| Team access denied | `ErrorState` 403 |
| User deletion | Privacy Center → delete account |
| Account disconnected or paused | That account's inbox, sidebar text, Accounts |
| Provider refuses a change | Toast after the rollback, from `GET /mail/refusals` |

Each of these is also rendered on `/design-system`, under System states.
