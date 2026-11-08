/**
 * The keyboard map. The help dialog and the design system both read this list, and the handlers live in
 * `Shell` (global) and `MailView` (list and conversation). Keep all three in step.
 */
export interface Shortcut { keys: string; does: string }
export const SHORTCUT_GROUPS: { title: string; items: Shortcut[] }[] = [
  { title: "Move around", items: [
    { keys: "Cmd/Ctrl + K", does: "Go to a page, run a command, or search" },
    { keys: "j / k", does: "Next or previous conversation" },
    { keys: "↓ / ↑", does: "Next or previous conversation" },
    { keys: "o or Enter", does: "Open the conversation" },
    { keys: "u", does: "Back to the list" },
    { keys: "Esc", does: "Close what's open, or go back to the list" },
    { keys: "/", does: "Search" },
  ] },
  { title: "Act on a conversation", items: [
    { keys: "e", does: "Archive" },
    { keys: "#", does: "Move to Trash" },
    { keys: "s", does: "Star or unstar" },
    { keys: "Shift+u", does: "Mark unread" },
    { keys: "l", does: "Labels" },
    { keys: "x", does: "Select" },
  ] },
  { title: "Write", items: [
    { keys: "c", does: "Compose" },
    { keys: "r", does: "Reply, in an open conversation" },
    { keys: "f", does: "Forward, in an open conversation" },
  ] },
  { title: "Panels", items: [
    { keys: "i", does: "Show or hide the summary" },
    { keys: "a", does: "Assistant" },
    { keys: "?", does: "This list" },
    { keys: "Shift E", does: "Explain this screen" },
  ] },
  { title: "Go to", items: [
    { keys: "g then f", does: "Focus" },
    { keys: "g then i", does: "Inbox" },
    { keys: "g then q", does: "Blocked" },
    { keys: "g then s", does: "Sent" },
    { keys: "g then d", does: "Drafts" },
    { keys: "g then t", does: "Tasks" },
    { keys: "g then l", does: "Labels" },
  ] },
];
export const GO_TO: Record<string, string> = { f: "/app/focus", i: "/app/inbox", q: "/app/quarantine", s: "/app/sent", d: "/app/drafts", t: "/app/tasks", l: "/app/labels" };
