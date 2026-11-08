/**
 * What every screen is for, in one file. Explain mode reads this. `find` is text on the screen (a heading, button or label) or a CSS selector
 * starting with `css:`, to point at. If it isn't on screen right now, the explanation still shows, with nothing highlighted.
 * Every page under /app and /admin must have an entry here: e2e/explain.spec.ts fails otherwise.
 */
export interface Note { find?: string; title: string; text: string }

const SHELL: Note[] = [
  { find: "css:[data-explain=search]", title: "Search", text: "Searches all your mailboxes at once. Press / to jump here. Operators like from: or has:attachment narrow it down, and the filter list is under Search in Settings and the Docs." },
  { find: "css:aside nav", title: "Your views", text: "Focus, Inbox and your folders, across every mailbox. Everything else, including each account, is under More. Theme and shortcuts are in the menu at top right." },
];

const MAIL: Note[] = [
  { find: "css:[data-testid=thread-row]", title: "A conversation", text: "Sender, subject and a snippet, with its account. Select it to read it. Hover for quick actions, or use e to archive, # to trash and s to star." },
  { find: "css:[data-testid=layout-switcher], Layout:", title: "Layout", text: "How this list is arranged, such as chronological or grouped by action. It only changes how you see it, and never moves anything." },
  { title: "Be careful", text: "Mail we aren't sure about is marked Be careful, with the reason in the message. Anything dangerous is kept out of your inbox." },
];

export const NOTES: Record<string, Note[]> = {
  "/app": [{ title: "Your start page", text: "This sends you to your chosen first view. Change it under Settings, Personalization." }],
  "/app/[view]": [
    { find: "css:main h1", title: "This view", text: "One view of your mail, across every connected mailbox." },
    ...MAIL,
  ],
  "/app/focus": [
    { find: "css:main h1", title: "Focus", text: "What looks like it needs you, in order. Security runs first, so a scam can't climb up by sounding urgent." },
    { find: "Security review", title: "Security review", text: "Flagged mail is kept apart from the ranking, here, however it's worded. Open it to see the evidence and decide." },
    { find: "css:[data-testid=thread-row]", title: "Why it's here", text: "Each row says why it ranked where it did. Teach it from Settings, People and learning, or turn AI organization off and get a plain chronological inbox." },
    { find: "Simulate new mail", title: "Simulate new mail", text: "Only in demo mode. It adds a synthetic message, and sends it through the real pipeline." },
  ],
  "/app/quarantine": [
    { find: "css:main h1", title: "Blocked", text: "Mail the AI stopped before it reached your inbox. It isn't deleted, and nothing in it runs or loads while it's here." },
    { find: "css:[data-testid=thread-row]", title: "A blocked message", text: "Open it to read it safely and see why it was blocked. If it was a mistake, release it." },
  ],
  "/app/connect": [
    { find: "Connect your email", title: "Connect your email", text: "Gmail and Outlook connect by signing in with Google or Microsoft, where this server has that switched on. iCloud and other hosts use an app password. Your Aegis Mail password is separate from all of them." },
    { title: "What happens next", text: "The last 30 days are fetched first. Each message is scanned, ranked and stored encrypted. Older mail stays with your provider." },
  ],
  "/app/connect/manual": [
    { find: "Sign-in", title: "Sign-in", text: "Your address and an app password from your mail host. It's sealed with your workspace's keys, and the web server can't read it back." },
    { find: "Confirm your server settings", title: "Server settings", text: "Where to fetch and send mail. Nothing's saved until a test connection succeeds. Private addresses are refused." },
  ],
  "/app/drafts": [
    { find: "css:main h1", title: "Drafts", text: "Unsent messages, sealed like the rest of your mail, including drafts an assistant wrote for you. A draft never sends itself." },
    { title: "Sending", text: "Open one to edit it. It's checked again when you send it, and if the text changes while it's being approved, the send is refused so you don't send what you didn't read." },
  ],
  "/app/scheduled": [
    { find: "css:main h1", title: "Scheduled", text: "Messages waiting for their send time, in the time zone you chose them in." },
    { title: "Changing your mind", text: "Cancel any time before it goes. It goes back to your drafts." },
  ],
  "/app/labels": [
    { find: "Create a label", title: "Create a label", text: "A label belongs to one account, as it does in your provider." },
    { find: "Your labels", title: "Your labels", text: "Renaming or deleting one here changes it everywhere in this workspace. Deleting a label doesn't delete the mail." },
  ],
  "/app/tasks": [
    { find: "Add a task", title: "Add a task", text: "Yours to write. Tasks also come from your mail, when a message contains a request or a date." },
    { find: "Up next", title: "Up next", text: "Due soonest first. “Maybe” means the date wasn't certain, so check it against the message." },
    { find: "Add to your calendar", title: "Calendar", text: "Downloads an event file for your calendar app. Nothing's connected to your calendar." },
  ],
  "/app/rules": [
    { find: "Build a rule", title: "Build a rule", text: "When a message matches, do these actions. You check it, test it on recent mail, then save it, in that order." },
    { find: "Automation level", title: "Automation level", text: "How much rules may do without asking. Whatever you set, rules can't release blocked mail, and blocked mail stays blocked." },
    { find: "Waiting for your approval", title: "Waiting for your approval", text: "Actions a rule wants to take that need your say first." },
  ],
  "/app/shared": [
    { find: "Share one of your mailboxes", title: "Share a mailbox", text: "Lets chosen teammates work from one of your mailboxes. You can stop at any time." },
    { find: "Shared with you", title: "Shared with you", text: "Mailboxes others let you use. Each one's owner can see that you have access." },
  ],
  "/app/privacy": [
    { find: "css:main h1", title: "Privacy Center", text: "Read from this server's live configuration, so it always matches what the system does." },
    { find: "How your mail is protected", title: "How your mail is protected", text: "What keeps your mail safe, in a few lines. How this works opens the detail." },
    { find: "Technical details", title: "Technical details", text: "Every service that sees readable text and when, your keys, and how each privacy mode compares." },
    { find: "Your controls", title: "Your controls", text: "Turn off AI features, attachment storage and server search here. Turning search off deletes its index." },
    { find: "Delete my account", title: "Delete your account", text: "Destroys your keys, which turns what's stored into noise. Backups taken before that stay readable until they expire." },
  ],
  "/app/security": [
    { find: "css:main h1", title: "Security Center", text: "For owners and security admins. Counts only: no subjects, senders or message text, for anyone." },
    { find: "By rating", title: "By rating", text: "How many messages got each rating in this period." },
    { find: "What happened to the mail", title: "What happened", text: "What the policy did with them: delivered, warned, held and so on." },
    { find: "Coverage", title: "Coverage", text: "How much of your mail was fully scanned. A low number means ratings have less behind them." },
  ],
  "/app/security-report/[messageId]": [
    { find: "This message, taken apart", title: "Taken apart", text: "One sheet for each thing checked, and a balance tipped by the same weights. It's drawn in your browser from this page's data." },
    { find: "The rating", title: "The rating", text: "The engine's verdict, and how complete the analysis was. An incomplete one says why." },
    { find: "Why", title: "Why", text: "Every finding, with what raised the risk and what lowered it. Your mail stays with you: this is printable, and nothing here is sent anywhere." },
    { find: "What was checked", title: "What was checked", text: "Which detectors ran. If one was unavailable or cut short, it's listed here." },
  ],
  "/app/insights": [
    { find: "css:main h1", title: "Insights", text: "Counted from your own mailboxes, for you alone: no subjects, senders or message text." },
    { find: "By mailbox", title: "By mailbox", text: "What came in, went out and got flagged, per mailbox." },
    { find: "When mail arrives", title: "When mail arrives", text: "By hour of day, in your time zone." },
  ],
  "/app/onboarding": [
    { find: "css:main h1", title: "Getting set up", text: "Connect the mailbox you already use. Once it's connected, this shows each mailbox as its mail comes in." },
  ],
  "/app/org": [
    { find: "Invite someone", title: "Invite someone", text: "They get a link by email, and choose their own password." },
    { find: "Members", title: "Members", text: "Who's in this workspace, and their role. Roles control settings: a workspace admin can't read a member's mail." },
    { find: "What each role can do", title: "Roles", text: "Exactly what each role allows." },
  ],
  "/app/org/audit": [
    { find: "css:main h1", title: "Audit log", text: "Who changed what, and when: sign-ins, policy changes, releases of blocked mail. It doesn't include message content." },
  ],
  "/app/org/domains": [
    { find: "Add a domain", title: "Add a domain", text: "Prove you control it with a DNS record. SSO needs this." },
    { find: "Your domains", title: "Your domains", text: "Verification is rechecked regularly. A domain that stops proving itself lapses." },
  ],
  "/app/org/blocked": [
    { find: "css:main h1", title: "Blocked mail", text: "Everything the AI stopped across the workspace. The people it was sent to never see it. Only owners and security admins can open this page." },
    { title: "No content here", text: "You see whose mailbox, when, and why. Never the subject, the sender or the body." },
  ],
  "/app/org/incidents": [
    { find: "css:main h1", title: "Incidents", text: "Messages someone chose to share with your security team, for a limited time. Nobody on the team can read mail nobody shared." },
    { title: "Ending a share", text: "The person who shared it can revoke it at any time." },
  ],
  "/app/org/policies": [
    { find: "Blocked mail", title: "Blocked mail", text: "Which rating gets blocked, and whether releasing the most dangerous mail needs an owner's or security admin's approval." },
    { find: "Mail handling", title: "Mail handling", text: "Workspace-wide rules, including blocking outbound mail to a domain. Blocks are checked when a message is approved and again when it's sent." },
    { find: "Data and AI", title: "Data and AI", text: "Turn off hosted models for everyone here. Security analysis keeps running either way, because it doesn't use them." },
    { find: "Encryption keys", title: "Encryption keys", text: "Rotate this workspace's keys. New data uses the new key, and old data stays readable." },
  ],
  "/app/org/sso": [
    { find: "Identity provider", title: "Identity provider", text: "OpenID Connect or SAML, for a domain you've verified. Test with one account before requiring it for everyone." },
    { find: "SCIM provisioning", title: "SCIM", text: "Lets your identity provider add and remove members. The token shows once." },
  ],
  "/app/settings": [
    { find: "css:main h1", title: "Settings", text: "Everything that's yours to set, as opposed to your workspace's." },
    { find: "Appearance and AI", title: "Appearance and AI", text: "Theme, layout, what you see first, and what the AI does for you." },
    { find: "Sign-in and security", title: "Sign-in and security", text: "Passkeys, two-step sign-in, recovery codes and where you're signed in." },
  ],
  "/app/settings/accounts": [
    { find: "css:main h1", title: "Accounts", text: "Your connected mailboxes, how each one is syncing, and what access it has." },
    { find: "Sync", title: "Sync", text: "When it last succeeded. If it stops, this says why, in words." },
    { title: "Disconnecting", text: "Stops the sync and revokes our access. You choose whether to keep the mail already here." },
  ],
  "/app/settings/identity": [
    { find: "css:main h1", title: "Signatures and addresses", text: "Which addresses each mailbox may send from, and the signature that goes with them." },
    { title: "Checked before sending", text: "The server refuses to send from an address that isn't verified for that mailbox." },
  ],
  "/app/settings/people": [
    { find: "css:main h1", title: "People and learning", text: "What Focus has learned from what you do, and how to correct it." },
    { find: "Rank whole accounts", title: "Rank accounts", text: "Put one mailbox's mail above or below the others." },
    { find: "Reset what's learned", title: "Reset", text: "Forgets all of it, and it starts again from your next actions." },
  ],
  "/app/settings/personalization": [
    { find: "Theme", title: "Theme", text: "Light, dark, or following your system. On the home page, dark puts the film under a spotlight." },
    { find: "Mail layout", title: "Mail layout", text: "How lists are arranged by default." },
    { find: "Focus sections", title: "Focus sections", text: "Which sections show, and in what order. Security review can't be hidden." },
    { find: "Working hours and quiet hours", title: "Quiet hours", text: "These decide when notifications arrive. They don't change how anything's ranked." },
  ],
  "/app/settings/search": [
    { find: "Word index", title: "Word index", text: "Words from subjects and bodies, stored unencrypted so the server can search them. Turning it off deletes it." },
    { find: "Semantic search", title: "Semantic search", text: "Finds mail by meaning, with a model running on this server. No mail text leaves it. Its vectors are sealed." },
    { find: "Related words", title: "Related words", text: "A short built-in list that widens your words, so payment also finds invoice." },
  ],
  "/app/settings/security": [
    { find: "Passkeys", title: "Passkeys", text: "The strongest way in. A passkey only works on this site, so it can't be phished." },
    { find: "Authenticator app", title: "Authenticator app", text: "A second factor. Keep the recovery codes somewhere safe: each works once." },
    { find: "Signed-in devices", title: "Signed-in devices", text: "Everywhere you're signed in. End any you don't recognize." },
  ],
  "/app/settings/topics": [
    { find: "Add a topic", title: "Add a topic", text: "A word or phrase you care about. Matching mail gets that topic." },
    { find: "Built-in topics", title: "Built-in topics", text: "Common ones, always on while topics are turned on in the Privacy Center." },
  ],
  "/admin": [
    { find: "css:main h1", title: "Operator overview", text: "For people running this deployment. Aggregates only: this console can't show mail, and its database role has no access to mail tables." },
    { find: "Connected mailboxes", title: "Connected mailboxes", text: "Across all tenants, as a count." },
    { find: "Dead jobs by kind and error code", title: "Dead jobs", text: "Work that's failed for good, by kind and code. Fix the cause, then retry them from Job queue." },
  ],
  "/admin/tenants": [
    { find: "css:main h1", title: "Tenants", text: "Search by name or owner's address. Selecting one shows counts, usage and limits, never mail." },
  ],
  "/admin/tenants/[id]": [
    { find: "Usage", title: "Usage", text: "Members, mailboxes and what's been counted each month, as numbers." },
    { find: "Limits", title: "Limits", text: "None by default. Sets or lifts a limit for this tenant, over the server's own default. Safety features aren't limits, so they can't be turned off here. Every change is audited." },
  ],
  "/admin/jobs": [
    { find: "css:main h1", title: "Job queue", text: "Kind and error code only. The belt counts jobs in each state. Payloads and tenants aren't shown, and can't be." },
    { find: "Show", title: "Show", text: "Choose a state. Dead jobs can be retried, and that's audited." },
  ],
  "/admin/health": [
    { find: "css:main h1", title: "System health", text: "Whether each part is running and configured. The dials show the same three states as the list: fine, off, and a problem." },
    { title: "What isn't here", text: "Secret values. This page only says whether one is set." },
  ],
  "/admin/audit": [
    { find: "css:main h1", title: "Operator audit log", text: "Everything operators did, oldest entries included. It's append-only, and no operator can edit it." },
  ],
};

/** The route pattern for a path, so /app/security-report/123 finds its entry. */
export function notesFor(path: string): Note[] {
  const p = path.replace(/\/$/, "") || "/";
  let found = NOTES[p];
  if (!found && /^\/app\/security-report\//.test(p)) found = NOTES["/app/security-report/[messageId]"];
  if (!found && /^\/admin\/tenants\//.test(p)) found = NOTES["/admin/tenants/[id]"];
  if (!found && /^\/app\/[^/]+$/.test(p)) found = NOTES["/app/[view]"];
  const shell = p.startsWith("/app") ? SHELL : [];
  return [...(found ?? []), ...shell];
}
