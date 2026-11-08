import {
  CursorExpiredError,
  RateLimitedError,
  SendOutcomeUnknownError,
  UnsupportedOperationError,
  type ConnectionTestResult,
  type FolderRole,
  type MailAdapter,
  type MailChange,
  type MessageChange,
  type OutboundMessage,
  type ProviderCapabilities,
  type RemoteFolder,
  type RemoteState,
  type SendResult,
  type SyncPage,
} from "@aegis/domain/mail";
import { apiBaseFor, revokeGoogleToken, type OAuthClientConfig, type TokenManager } from "./oauth";
import {
  ProviderHttpError,
  ProviderNetworkError,
  composeMime,
  effectiveCapabilities,
  mapLimit,
  normalizeMessageId,
  parseRetryAfter,
  readJson,
  safeCode,
} from "./shared";
import { classifyHttpProblem } from "./http-problem";

const CONCURRENCY = 8;
const MAX_PAGE = 500;
const RATE_REASONS = new Set(["ratelimitexceeded", "userratelimitexceeded", "rate_limit_exceeded"]);

const FOLDER_LABELS = new Set(["INBOX", "SENT", "DRAFT", "SPAM", "TRASH"]);
const STATE_LABELS = new Set([...FOLDER_LABELS, "UNREAD", "STARRED"]);

export function gmailFolderRole(labelIds: readonly string[]): FolderRole {
  // TRASH and SPAM win: Gmail only ever sets them alone, but a self-sent mail is both INBOX and SENT.
  if (labelIds.includes("TRASH")) return "trash";
  if (labelIds.includes("SPAM")) return "spam";
  if (labelIds.includes("DRAFT")) return "drafts";
  if (labelIds.includes("INBOX")) return "inbox";
  if (labelIds.includes("SENT")) return "sent";
  return "archive";
}

interface FullCursor { phase: "full"; historyId: string; pageToken: string }
interface HistoryCursor { phase: "history"; startHistoryId: string; pageToken: string }

function parseCursor(cursor: string): FullCursor | HistoryCursor | { phase: "done"; historyId: string } {
  if (/^\d+$/.test(cursor)) return { phase: "done", historyId: cursor };
  try {
    const parsed = JSON.parse(cursor);
    if (parsed?.phase === "full" && /^\d+$/.test(parsed.historyId) && typeof parsed.pageToken === "string") return parsed;
    if (parsed?.phase === "history" && /^\d+$/.test(parsed.startHistoryId) && typeof parsed.pageToken === "string") return parsed;
  } catch { /* falls through */ }
  throw new CursorExpiredError("Gmail cursor is not usable");
}

/**
 * Decodes a Pub/Sub push envelope to the Gmail hint inside it. Strict: returns null for anything malformed.
 * The result is only a sync hint and proves nothing; authenticate the push request separately.
 */
export function parseGmailPush(body: unknown): { emailAddress: string; historyId: string } | null {
  try {
    const envelope = typeof body === "string" ? JSON.parse(body) : body;
    const data = envelope?.message?.data;
    if (typeof data !== "string" || data.length === 0 || data.length > 4096) return null;
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(data)) return null;
    const decoded = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const { emailAddress, historyId } = decoded;
    if (typeof emailAddress !== "string" || !/^[^\s@]+@[^\s@]+$/.test(emailAddress)) return null;
    // historyId is a uint64. A JSON number past 2^53 has already lost digits, so it can't be used.
    if (typeof historyId === "number") {
      if (!Number.isSafeInteger(historyId) || historyId < 0) return null;
      return { emailAddress, historyId: String(historyId) };
    }
    if (typeof historyId !== "string" || !/^\d{1,20}$/.test(historyId)) return null;
    return { emailAddress, historyId };
  } catch {
    return null;
  }
}

export interface GmailAdapterOptions {
  account: { email: string; readOnly: boolean };
  tokens: TokenManager;
  oauth?: OAuthClientConfig;
  fetch?: typeof fetch;
  pubsubTopic?: string;
  now?: () => number;
}

export function createGmailAdapter(opts: GmailAdapterOptions): MailAdapter {
  return new GmailAdapter(opts);
}

class GmailAdapter implements MailAdapter {
  readonly kind = "gmail" as const;
  readonly capabilities: ProviderCapabilities;
  #opts: GmailAdapterOptions;
  #base: string;
  #labels: Map<string, string> | undefined;
  #labelsLoading: Promise<Map<string, string>> | undefined;

  constructor(opts: GmailAdapterOptions) {
    this.#opts = opts;
    this.#base = `${apiBaseFor("gmail", opts.oauth)}/users/me`;
    this.capabilities = effectiveCapabilities("gmail", { readOnly: opts.account.readOnly, push: !!opts.pubsubTopic });
  }

  #now(): number {
    return (this.#opts.now ?? Date.now)();
  }

  async #toError(res: Response): Promise<Error> {
    const body = await res.json().catch(() => undefined);
    const reasons: unknown[] = [
      ...(Array.isArray(body?.error?.errors) ? body.error.errors.map((e: any) => e?.reason) : []),
      ...(Array.isArray(body?.error?.details) ? body.error.details.map((d: any) => d?.reason) : []),
    ];
    const rateLimited = reasons.some((r) => typeof r === "string" && RATE_REASONS.has(r.toLowerCase()));
    if (res.status === 429 || (res.status === 403 && rateLimited)) {
      return new RateLimitedError("Gmail rate limit reached", parseRetryAfter(res.headers.get("retry-after"), this.#now()));
    }
    const code = safeCode(reasons[0]);
    return new ProviderHttpError(`Gmail API request failed (${res.status}${code ? ` ${code}` : ""})`, res.status, code);
  }

  async #request(path: string, init?: RequestInit): Promise<Response> {
    const res = await this.#opts.tokens.fetch(`${this.#base}${path}`, init);
    if (res.ok) return res;
    throw await this.#toError(res);
  }

  async #json(path: string, init?: RequestInit): Promise<any> {
    return readJson(await this.#request(path, init), "Gmail API");
  }

  async #post(path: string, body: unknown): Promise<any> {
    return this.#json(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  /** Concurrent message fetches share one labels.list call. */
  #loadLabels(): Promise<Map<string, string>> {
    this.#labelsLoading ??= this.#json("/labels")
      .then((body) => {
        const list: any[] = Array.isArray(body?.labels) ? body.labels : [];
        this.#labels = new Map(list.filter((l) => typeof l?.id === "string").map((l) => [l.id, String(l.name ?? l.id)]));
        return this.#labels;
      })
      .finally(() => { this.#labelsLoading = undefined; });
    return this.#labelsLoading;
  }

  /** Label names for the non-state labels on a message. Reloads the cache once for a label it hasn't seen. */
  async #labelNames(labelIds: readonly string[]): Promise<string[]> {
    const others = labelIds.filter((id) => !STATE_LABELS.has(id));
    if (others.length === 0) return [];
    let labels = this.#labels ?? (await this.#loadLabels());
    if (others.some((id) => !labels.has(id))) {
      labels = await this.#loadLabels();
      // Remember an id labels.list doesn't know, so it can't force a reload for every message.
      for (const id of others) if (!labels.has(id)) labels.set(id, id);
    }
    return others.map((id) => labels.get(id) as string);
  }

  async #toState(labelIds: readonly string[]): Promise<RemoteState> {
    return {
      folderRole: gmailFolderRole(labelIds),
      labels: await this.#labelNames(labelIds),
      isRead: !labelIds.includes("UNREAD"),
      isStarred: labelIds.includes("STARRED"),
    };
  }

  #messagePath(id: string, format: "raw" | "minimal"): string {
    return `/messages/${encodeURIComponent(id)}?format=${format}`;
  }

  /** A 404 means the message went away between listing and fetching, which is a delete. */
  async #fetchUpsert(id: string): Promise<MailChange> {
    let body: any;
    try {
      body = await this.#json(this.#messagePath(id, "raw"));
    } catch (err) {
      if (err instanceof ProviderHttpError && err.status === 404) return { type: "delete", remoteId: id };
      throw err;
    }
    if (typeof body?.raw !== "string") throw new Error("Gmail API returned a message without raw content");
    const labelIds: string[] = Array.isArray(body.labelIds) ? body.labelIds : [];
    const internal = Number(body.internalDate);
    return {
      type: "upsert",
      remoteId: id,
      ...(typeof body.threadId === "string" ? { remoteThreadId: body.threadId } : {}),
      internalDate: new Date(Number.isFinite(internal) ? internal : this.#now()).toISOString(),
      state: await this.#toState(labelIds),
      raw: new Uint8Array(Buffer.from(body.raw, "base64url")),
    };
  }

  async #fetchState(id: string): Promise<MailChange> {
    let body: any;
    try {
      body = await this.#json(this.#messagePath(id, "minimal"));
    } catch (err) {
      if (err instanceof ProviderHttpError && err.status === 404) return { type: "delete", remoteId: id };
      throw err;
    }
    return { type: "state", remoteId: id, state: await this.#toState(Array.isArray(body?.labelIds) ? body.labelIds : []) };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      await this.#json("/profile");
      return { ok: true, folders: (await this.listFolders()).length };
    } catch (err) {
      return classifyHttpProblem(err);
    }
  }

  async listFolders(): Promise<RemoteFolder[]> {
    const body = await this.#json("/labels");
    const list: any[] = Array.isArray(body?.labels) ? body.labels : [];
    this.#labels = new Map(list.filter((l) => typeof l?.id === "string").map((l) => [l.id, String(l.name ?? l.id)]));
    const folders: RemoteFolder[] = [];
    for (const label of list) {
      if (typeof label?.id !== "string") continue;
      const name = String(label.name ?? label.id);
      if (FOLDER_LABELS.has(label.id)) folders.push({ remoteId: label.id, name, role: gmailFolderRole([label.id]) });
      else if (label.type === "user") folders.push({ remoteId: label.id, name, role: "custom" });
    }
    // Gmail's archive has no label: it is whatever carries none of the folder labels.
    folders.push({ remoteId: "ALL_MAIL", name: "All Mail", role: "archive" });
    return folders;
  }

  async fullSync(opts: { windowDays: number; pageSize: number; cursor?: string }): Promise<SyncPage> {
    if (!Number.isInteger(opts.windowDays) || opts.windowDays < 1) throw new TypeError("windowDays must be a positive integer");
    let historyId: string;
    let pageToken: string | undefined;
    if (opts.cursor) {
      const parsed = parseCursor(opts.cursor);
      if (parsed.phase === "done") return { changes: [], cursor: opts.cursor, hasMore: false };
      if (parsed.phase !== "full") throw new CursorExpiredError("Gmail cursor is not a full sync cursor");
      historyId = parsed.historyId;
      pageToken = parsed.pageToken;
    } else {
      // Captured before listing, so anything that changes during the sync is replayed by history.list.
      const profile = await this.#json("/profile");
      if (!/^\d+$/.test(String(profile?.historyId))) throw new Error("Gmail profile has no historyId");
      historyId = String(profile.historyId);
    }
    const query = new URLSearchParams({
      q: `newer_than:${opts.windowDays}d`,
      maxResults: String(Math.min(Math.max(opts.pageSize, 1), MAX_PAGE)),
      // Spam and trash are mapped folders; without this they'd only ever appear through history.
      includeSpamTrash: "true",
    });
    if (pageToken) query.set("pageToken", pageToken);
    const body = await this.#json(`/messages?${query}`);
    const ids: string[] = (Array.isArray(body?.messages) ? body.messages : []).map((m: any) => m?.id).filter((id: unknown) => typeof id === "string");
    const changes = await mapLimit(ids, CONCURRENCY, (id) => this.#fetchUpsert(id));
    if (typeof body?.nextPageToken === "string") {
      const next: FullCursor = { phase: "full", historyId, pageToken: body.nextPageToken };
      return { changes, cursor: JSON.stringify(next), hasMore: true };
    }
    return { changes, cursor: historyId, hasMore: false };
  }

  async incrementalSync(cursor: string, opts: { pageSize: number }): Promise<SyncPage> {
    const parsed = parseCursor(cursor);
    if (parsed.phase === "full") throw new CursorExpiredError("Gmail full sync has not finished");
    const startHistoryId = parsed.phase === "done" ? parsed.historyId : parsed.startHistoryId;
    const query = new URLSearchParams({ startHistoryId, maxResults: String(Math.min(Math.max(opts.pageSize, 1), MAX_PAGE)) });
    for (const type of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]) query.append("historyTypes", type);
    if (parsed.phase === "history") query.set("pageToken", parsed.pageToken);

    let body: any;
    try {
      body = await this.#json(`/history?${query}`);
    } catch (err) {
      if (err instanceof ProviderHttpError && err.status === 404) throw new CursorExpiredError("Gmail history is no longer available");
      throw err;
    }

    // One action per message for this page. A delete always wins; a new message beats a label change.
    const actions = new Map<string, "upsert" | "state" | "delete">();
    const ids = (entries: unknown): string[] =>
      (Array.isArray(entries) ? entries : []).map((e: any) => e?.message?.id).filter((id: unknown): id is string => typeof id === "string");
    for (const record of Array.isArray(body?.history) ? body.history : []) {
      for (const id of ids(record?.messagesAdded)) if (actions.get(id) !== "delete") actions.set(id, "upsert");
      for (const id of [...ids(record?.labelsAdded), ...ids(record?.labelsRemoved)]) if (!actions.has(id)) actions.set(id, "state");
      for (const id of ids(record?.messagesDeleted)) actions.set(id, "delete");
    }

    const changes = await mapLimit([...actions], CONCURRENCY, async ([id, action]): Promise<MailChange> => {
      if (action === "delete") return { type: "delete", remoteId: id };
      return action === "upsert" ? this.#fetchUpsert(id) : this.#fetchState(id);
    });

    if (typeof body?.nextPageToken === "string") {
      const next: HistoryCursor = { phase: "history", startHistoryId, pageToken: body.nextPageToken };
      return { changes, cursor: JSON.stringify(next), hasMore: true };
    }
    const latest = /^\d+$/.test(String(body?.historyId)) ? String(body.historyId) : startHistoryId;
    return { changes, cursor: latest, hasMore: false };
  }

  async fetchRaw(remoteId: string): Promise<Uint8Array> {
    const body = await this.#json(this.#messagePath(remoteId, "raw"));
    if (typeof body?.raw !== "string") throw new Error("Gmail API returned a message without raw content");
    return new Uint8Array(Buffer.from(body.raw, "base64url"));
  }

  async #labelIdsFor(names: readonly string[], create: boolean): Promise<string[]> {
    if (names.length === 0) return [];
    let labels = this.#labels ?? (await this.#loadLabels());
    const byName = (name: string) => [...labels].find(([, n]) => n === name)?.[0];
    if (names.some((n) => !byName(n))) labels = await this.#loadLabels();
    const out: string[] = [];
    for (const name of names) {
      let id = byName(name);
      if (!id && create) {
        const made = await this.#post("/labels", { name });
        if (typeof made?.id !== "string") throw new Error("Gmail API did not return the new label");
        id = made.id as string;
        labels.set(id, name);
      }
      if (id) out.push(id);
    }
    return out;
  }

  async applyChange(remoteId: string, change: MessageChange): Promise<void> {
    if (this.#opts.account.readOnly) throw new UnsupportedOperationError("This account is connected read-only");
    const role = change.moveToRole;
    if (role === "sent" || role === "drafts" || role === "custom") {
      throw new UnsupportedOperationError(`Gmail can't move a message to ${role}`);
    }
    const add = new Set(await this.#labelIdsFor(change.addLabels ?? [], true));
    const remove = new Set(await this.#labelIdsFor(change.removeLabels ?? [], false));
    if (change.isRead === true) remove.add("UNREAD");
    if (change.isRead === false) add.add("UNREAD");
    if (change.isStarred === true) add.add("STARRED");
    if (change.isStarred === false) remove.add("STARRED");
    if (role === "archive") { remove.add("INBOX"); remove.add("SPAM"); }
    if (role === "spam") { add.add("SPAM"); remove.add("INBOX"); }
    if (role === "inbox") { add.add("INBOX"); remove.add("SPAM"); }

    const id = encodeURIComponent(remoteId);
    // TRASH can't be changed through modify; leaving the trash takes untrash.
    if (role && role !== "trash") {
      const current = await this.#json(this.#messagePath(remoteId, "minimal"));
      if (Array.isArray(current?.labelIds) && current.labelIds.includes("TRASH")) await this.#post(`/messages/${id}/untrash`, {});
    }
    if (add.size > 0 || remove.size > 0) {
      await this.#post(`/messages/${id}/modify`, { addLabelIds: [...add], removeLabelIds: [...remove] });
    }
    if (role === "trash") await this.#post(`/messages/${id}/trash`, {});
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.#opts.account.readOnly) throw new UnsupportedOperationError("This account is connected read-only");
    const { raw } = await composeMime(message, { keepBcc: true });
    const payload = { raw: raw.toString("base64url"), ...(message.remoteThreadId ? { threadId: message.remoteThreadId } : {}) };
    let res: Response;
    try {
      res = await this.#opts.tokens.fetch(`${this.#base}/messages/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (err instanceof ProviderNetworkError) throw new SendOutcomeUnknownError("Gmail send outcome is unknown; reconcile before retrying");
      throw err;
    }
    if (res.status >= 500) {
      void res.body?.cancel().catch(() => undefined);
      throw new SendOutcomeUnknownError(`Gmail send outcome is unknown (${res.status}); reconcile before retrying`);
    }
    if (!res.ok) throw await this.#toError(res);
    // The server accepted it. An unreadable body doesn't change that.
    const body = await res.json().catch(() => undefined);
    return { ...(typeof body?.id === "string" ? { remoteId: body.id } : {}), acceptedAt: new Date(this.#now()).toISOString() };
  }

  async findSentByMessageId(messageId: string): Promise<{ remoteId: string } | null> {
    const bare = normalizeMessageId(messageId).slice(1, -1);
    // Trash is included: a sent message the user then deleted was still sent.
    const query = new URLSearchParams({ q: `rfc822msgid:${bare}`, includeSpamTrash: "true", maxResults: "5" });
    const body = await this.#json(`/messages?${query}`);
    for (const entry of Array.isArray(body?.messages) ? body.messages : []) {
      if (typeof entry?.id !== "string") continue;
      // A saved draft with the same id has not been sent.
      const current = await this.#json(this.#messagePath(entry.id, "minimal"));
      if (Array.isArray(current?.labelIds) && current.labelIds.includes("SENT")) return { remoteId: entry.id };
    }
    return null;
  }

  async renewPush(): Promise<{ expiresAt: string; state?: Record<string, string> } | null> {
    if (!this.#opts.pubsubTopic) return null;
    const body = await this.#post("/watch", { topicName: this.#opts.pubsubTopic, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" });
    const expiration = Number(body?.expiration);
    if (!Number.isFinite(expiration) || expiration <= 0) throw new Error("Gmail watch response has no expiration");
    return { expiresAt: new Date(expiration).toISOString() };
  }

  async stopPush(): Promise<void> {
    await this.#request("/stop", { method: "POST" });
  }

  async revoke(): Promise<boolean> {
    return revokeGoogleToken(this.#opts.tokens.revocationToken, {
      ...(this.#opts.oauth ? { config: this.#opts.oauth } : {}),
      ...(this.#opts.fetch ? { fetch: this.#opts.fetch } : {}),
    });
  }
}
