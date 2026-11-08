import { createHash, timingSafeEqual } from "node:crypto";
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
import { classifyHttpProblem } from "./http-problem";
import { apiBaseFor, type OAuthClientConfig, type TokenManager } from "./oauth";
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

const CONCURRENCY = 6;
const MAX_PAGE = 100;
/** Graph allows 10,080 minutes without resource data. We ask for about 6 days. */
export const GRAPH_SUBSCRIPTION_MINUTES = 6 * 24 * 60;

const WELL_KNOWN: ReadonlyArray<readonly [string, FolderRole]> = [
  ["inbox", "inbox"], ["sentitems", "sent"], ["drafts", "drafts"], ["archive", "archive"], ["junkemail", "spam"], ["deleteditems", "trash"],
];
const ROLE_TO_WELL_KNOWN: Partial<Record<FolderRole, string>> = Object.fromEntries(WELL_KNOWN.map(([name, role]) => [role, name]));

/**
 * `categories` is selected in addition to the listed fields: without it every sync would report a
 * message as having no labels and wipe the categories we write in applyChange.
 */
const DELTA_SELECT = "id,conversationId,isRead,flag,receivedDateTime,parentFolderId,categories";
const CURSOR_EXPIRED_CODES = new Set(["syncstatenotfound", "syncstateinvalid", "resyncrequired"]);

type FolderLink = { deltaLink: string } | { nextLink: string };
type DeltaCursor = Record<string, FolderLink>;

function parseDeltaCursor(cursor: string): DeltaCursor {
  try {
    const parsed = JSON.parse(cursor);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const valid = Object.values(parsed).every((v: any) => typeof v?.deltaLink === "string" || typeof v?.nextLink === "string");
      if (valid) return parsed as DeltaCursor;
    }
  } catch { /* falls through */ }
  throw new CursorExpiredError("Graph cursor is not usable");
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export type GraphNotification =
  | { kind: "change"; subscriptionId: string; changeType: "created" | "updated" | "deleted"; resource: string; messageId?: string }
  | { kind: "lifecycle"; subscriptionId: string; lifecycleEvent: "missed" | "subscriptionRemoved" | "reauthorizationRequired" };

/**
 * Returns the notifications that carry the expected clientState and are well formed, reduced to the
 * IDs we need. Everything else on the wire is dropped, so nothing else can reach later processing.
 */
export function validateGraphNotification(payload: unknown, expectedClientState: string): GraphNotification[] {
  const value = (payload as { value?: unknown })?.value;
  if (!Array.isArray(value) || !expectedClientState) return [];
  const expected = sha256(expectedClientState);
  const out: GraphNotification[] = [];
  for (const n of value) {
    if (typeof n?.clientState !== "string" || typeof n?.subscriptionId !== "string" || !n.subscriptionId) continue;
    // Hashing first gives equal lengths, so timingSafeEqual can't throw or reveal the length.
    if (!timingSafeEqual(sha256(n.clientState), expected)) continue;
    if (n.lifecycleEvent === "missed" || n.lifecycleEvent === "subscriptionRemoved" || n.lifecycleEvent === "reauthorizationRequired") {
      out.push({ kind: "lifecycle", subscriptionId: n.subscriptionId, lifecycleEvent: n.lifecycleEvent });
    } else if ((n.changeType === "created" || n.changeType === "updated" || n.changeType === "deleted") && typeof n.resource === "string") {
      const messageId = typeof n.resourceData?.id === "string" ? n.resourceData.id : undefined;
      out.push({ kind: "change", subscriptionId: n.subscriptionId, changeType: n.changeType, resource: n.resource, ...(messageId ? { messageId } : {}) });
    }
  }
  return out;
}

/** The subscription validation handshake: echoes validationToken as text/plain, or null if it isn't one. */
export function graphValidationResponse(url: string | URL): Response | null {
  let token: string | null;
  try {
    token = new URL(url).searchParams.get("validationToken");
  } catch {
    return null;
  }
  if (!token || token.length > 4096) return null;
  return new Response(token, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
}

export interface MicrosoftAdapterOptions {
  account: { email: string; readOnly: boolean };
  tokens: TokenManager;
  oauth?: OAuthClientConfig;
  webhookUrl?: string;
  clientState?: string;
  now?: () => number;
}

export function createMicrosoftAdapter(opts: MicrosoftAdapterOptions): MailAdapter {
  return new MicrosoftAdapter(opts);
}

class MicrosoftAdapter implements MailAdapter {
  readonly kind = "microsoft" as const;
  readonly capabilities: ProviderCapabilities;
  #opts: MicrosoftAdapterOptions;
  #base: string;
  #folders: Array<RemoteFolder> | undefined;
  #subscriptionId: string | undefined;

  constructor(opts: MicrosoftAdapterOptions) {
    this.#opts = opts;
    this.#base = apiBaseFor("microsoft", opts.oauth);
    this.capabilities = effectiveCapabilities("microsoft", { readOnly: opts.account.readOnly, push: !!opts.webhookUrl && !!opts.clientState });
  }

  #now(): number {
    return (this.#opts.now ?? Date.now)();
  }

  async #toError(res: Response): Promise<Error> {
    const retryAfter = parseRetryAfter(res.headers.get("retry-after"), this.#now());
    const body = await res.json().catch(() => undefined);
    if (res.status === 429 || res.status === 503) return new RateLimitedError(`Graph is throttling requests (${res.status})`, retryAfter);
    const code = safeCode(body?.error?.code);
    return new ProviderHttpError(`Graph request failed (${res.status}${code ? ` ${code}` : ""})`, res.status, code);
  }

  async #request(pathOrUrl: string, init?: RequestInit): Promise<Response> {
    const url = pathOrUrl.startsWith("/") ? `${this.#base}${pathOrUrl}` : pathOrUrl;
    const res = await this.#opts.tokens.fetch(url, init);
    if (res.ok) return res;
    throw await this.#toError(res);
  }

  async #json(pathOrUrl: string, init?: RequestInit): Promise<any> {
    return readJson(await this.#request(pathOrUrl, init), "Graph");
  }

  #jsonInit(method: string, body: unknown): RequestInit {
    return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  }

  async #discover(): Promise<RemoteFolder[]> {
    if (this.#folders) return this.#folders;
    const found = await mapLimit(WELL_KNOWN, CONCURRENCY, async ([name, role]) => {
      try {
        const body = await this.#json(`/me/mailFolders/${name}?$select=id,displayName`);
        return typeof body?.id === "string" ? { remoteId: body.id as string, name: String(body.displayName ?? name), role } : null;
      } catch (err) {
        // Some mailboxes have no archive folder until one is first used.
        if (err instanceof ProviderHttpError && err.status === 404) return null;
        throw err;
      }
    });
    this.#folders = found.filter((f): f is RemoteFolder => f !== null);
    return this.#folders;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      return { ok: true, folders: (await this.#discover()).length };
    } catch (err) {
      return classifyHttpProblem(err);
    }
  }

  listFolders(): Promise<RemoteFolder[]> {
    return this.#discover();
  }

  /** Links come from persisted cursors and carry our bearer token, so they can only go to the Graph origin. */
  #assertGraphLink(link: string): void {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new CursorExpiredError("Graph cursor is not usable");
    }
    if (url.origin !== new URL(this.#base).origin) throw new CursorExpiredError("Graph cursor points outside Graph");
  }

  async #deltaPage(url: string, pageSize: number): Promise<any> {
    const res = await this.#opts.tokens.fetch(url, {
      headers: { prefer: `odata.maxpagesize=${Math.min(Math.max(pageSize, 1), MAX_PAGE)}` },
    });
    if (res.ok) return readJson(res, "Graph");
    const err = await this.#toError(res);
    const code = err instanceof ProviderHttpError ? err.code?.toLowerCase() : undefined;
    if (res.status === 410 || res.status === 404 || (code && CURSOR_EXPIRED_CODES.has(code))) {
      throw new CursorExpiredError("Graph delta state is no longer available");
    }
    throw err;
  }

  #toState(item: any, role: FolderRole): RemoteState {
    return {
      folderRole: role,
      labels: Array.isArray(item?.categories) ? item.categories.filter((c: unknown) => typeof c === "string") : [],
      isRead: item?.isRead === true,
      isStarred: item?.flag?.flagStatus === "flagged",
    };
  }

  /**
   * Delta doesn't say whether an item is new or only changed, and this adapter keeps no record of what
   * it has seen, so every upsert carries MIME. A 404 means it was removed since the delta was read.
   */
  async #toChange(item: any, role: FolderRole): Promise<MailChange | null> {
    if (typeof item?.id !== "string") return null;
    if (item["@removed"]) return { type: "delete", remoteId: item.id };
    let res: Response;
    try {
      res = await this.#request(`/me/messages/${encodeURIComponent(item.id)}/$value`);
    } catch (err) {
      if (err instanceof ProviderHttpError && err.status === 404) return { type: "delete", remoteId: item.id };
      throw err;
    }
    return {
      type: "upsert",
      remoteId: item.id,
      ...(typeof item.conversationId === "string" ? { remoteThreadId: item.conversationId } : {}),
      internalDate: typeof item.receivedDateTime === "string" ? item.receivedDateTime : new Date(this.#now()).toISOString(),
      state: this.#toState(item, role),
      raw: new Uint8Array(await res.arrayBuffer()),
    };
  }

  /** Reads one delta page for a folder and records where to continue. */
  async #syncFolder(folder: RemoteFolder | undefined, url: string, pageSize: number, cursor: DeltaCursor, folderId: string): Promise<MailChange[]> {
    const body = await this.#deltaPage(url, pageSize);
    const items: any[] = Array.isArray(body?.value) ? body.value : [];
    const changes = await mapLimit(items, CONCURRENCY, (item) => this.#toChange(item, folder?.role ?? "custom"));
    const next = body?.["@odata.nextLink"];
    const delta = body?.["@odata.deltaLink"];
    if (typeof next === "string") { this.#assertGraphLink(next); cursor[folderId] = { nextLink: next }; }
    else if (typeof delta === "string") { this.#assertGraphLink(delta); cursor[folderId] = { deltaLink: delta }; }
    else throw new Error("Graph delta response has neither a next nor a delta link");
    return changes.filter((c): c is MailChange => c !== null);
  }

  async fullSync(opts: { windowDays: number; pageSize: number; cursor?: string }): Promise<SyncPage> {
    if (!Number.isInteger(opts.windowDays) || opts.windowDays < 1) throw new TypeError("windowDays must be a positive integer");
    const folders = await this.#discover();
    const cursor = opts.cursor ? parseDeltaCursor(opts.cursor) : {};
    const changes: MailChange[] = [];
    const since = new Date(this.#now() - opts.windowDays * 86_400_000).toISOString();
    for (const folder of folders) {
      if (changes.length >= opts.pageSize) break;
      const entry = cursor[folder.remoteId];
      if (entry && "deltaLink" in entry) continue;
      let url: string;
      if (entry) {
        this.#assertGraphLink(entry.nextLink);
        url = entry.nextLink;
      } else {
        // The filter only goes on the first request; the links Graph returns carry it. Graph caps a filtered delta at 5,000 messages.
        const filter = encodeURIComponent(`receivedDateTime ge ${since}`);
        url = `${this.#base}/me/mailFolders/${encodeURIComponent(folder.remoteId)}/messages/delta?$select=${DELTA_SELECT}&$filter=${filter}`;
      }
      changes.push(...(await this.#syncFolder(folder, url, opts.pageSize, cursor, folder.remoteId)));
    }
    const hasMore = folders.some((f) => { const e = cursor[f.remoteId]; return !e || "nextLink" in e; });
    return { changes, cursor: JSON.stringify(cursor), hasMore };
  }

  async incrementalSync(cursorValue: string, opts: { pageSize: number }): Promise<SyncPage> {
    const cursor = parseDeltaCursor(cursorValue);
    const folders = await this.#discover();
    const changes: MailChange[] = [];
    let cutShort = false;
    for (const folderId of Object.keys(cursor)) {
      if (changes.length >= opts.pageSize) { cutShort = true; break; }
      const entry = cursor[folderId] as FolderLink;
      const link = "nextLink" in entry ? entry.nextLink : entry.deltaLink;
      this.#assertGraphLink(link);
      const folder = folders.find((f) => f.remoteId === folderId);
      changes.push(...(await this.#syncFolder(folder, link, opts.pageSize, cursor, folderId)));
    }
    const hasMore = cutShort || Object.values(cursor).some((e) => "nextLink" in e);
    return { changes, cursor: JSON.stringify(cursor), hasMore };
  }

  async fetchRaw(remoteId: string): Promise<Uint8Array> {
    const res = await this.#request(`/me/messages/${encodeURIComponent(remoteId)}/$value`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async applyChange(remoteId: string, change: MessageChange): Promise<void | { remoteId?: string }> {
    if (this.#opts.account.readOnly) throw new UnsupportedOperationError("This account is connected read-only");
    const destination = change.moveToRole ? ROLE_TO_WELL_KNOWN[change.moveToRole] : undefined;
    if (change.moveToRole && !destination) throw new UnsupportedOperationError(`Graph can't move a message to ${change.moveToRole}`);

    const id = encodeURIComponent(remoteId);
    const patch: Record<string, unknown> = {};
    if (change.isRead !== undefined) patch.isRead = change.isRead;
    if (change.isStarred !== undefined) patch.flag = { flagStatus: change.isStarred ? "flagged" : "notFlagged" };
    if (change.addLabels?.length || change.removeLabels?.length) {
      const current = await this.#json(`/me/messages/${id}?$select=categories`);
      const set = new Set<string>(Array.isArray(current?.categories) ? current.categories : []);
      for (const label of change.addLabels ?? []) set.add(label);
      for (const label of change.removeLabels ?? []) set.delete(label);
      patch.categories = [...set];
    }
    if (Object.keys(patch).length > 0) await this.#request(`/me/messages/${id}`, this.#jsonInit("PATCH", patch));
    // Last: a move gives the message a new id, so nothing can follow it under this one.
    if (!destination) return undefined;
    const res = await this.#request(`/me/messages/${id}/move`, this.#jsonInit("POST", { destinationId: destination }));
    // The response is the message under its new id. Without it the caller falls back to sync seeing a delete and a new arrival.
    const moved = await res.json().catch(() => null) as { id?: unknown } | null;
    return typeof moved?.id === "string" ? { remoteId: moved.id } : undefined;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.#opts.account.readOnly) throw new UnsupportedOperationError("This account is connected read-only");
    const { raw } = await composeMime(message, { keepBcc: true });
    let res: Response;
    try {
      res = await this.#opts.tokens.fetch(`${this.#base}/me/sendMail`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: raw.toString("base64"),
      });
    } catch (err) {
      if (err instanceof ProviderNetworkError) throw new SendOutcomeUnknownError("Graph send outcome is unknown; reconcile before retrying");
      throw err;
    }
    // 503 is unknown here, not throttling: on a write we can't tell whether it took effect.
    if (res.status >= 500) {
      void res.body?.cancel().catch(() => undefined);
      throw new SendOutcomeUnknownError(`Graph send outcome is unknown (${res.status}); reconcile before retrying`);
    }
    if (!res.ok) throw await this.#toError(res);
    return { acceptedAt: new Date(this.#now()).toISOString() };
  }

  async findSentByMessageId(messageId: string): Promise<{ remoteId: string } | null> {
    const escaped = normalizeMessageId(messageId).replace(/'/g, "''");
    const filter = encodeURIComponent(`internetMessageId eq '${escaped}'`);
    const body = await this.#json(`/me/mailFolders/sentitems/messages?$filter=${filter}&$select=id&$top=1`);
    const first = Array.isArray(body?.value) ? body.value[0] : undefined;
    return typeof first?.id === "string" ? { remoteId: first.id } : null;
  }

  /** This app's subscription for our webhook, found by URL because the adapter may be freshly created. */
  async #findSubscription(): Promise<string | undefined> {
    if (this.#subscriptionId) return this.#subscriptionId;
    const body = await this.#json("/subscriptions");
    const list: any[] = Array.isArray(body?.value) ? body.value : [];
    const match = list.find((s) => s?.notificationUrl === this.#opts.webhookUrl && typeof s?.id === "string");
    return match?.id;
  }

  async renewPush(): Promise<{ expiresAt: string; state?: Record<string, string> } | null> {
    const { webhookUrl, clientState } = this.#opts;
    if (!webhookUrl || !clientState) return null;
    const expirationDateTime = new Date(this.#now() + GRAPH_SUBSCRIPTION_MINUTES * 60_000).toISOString();
    const existing = await this.#findSubscription();
    let body: any;
    if (existing) {
      try {
        body = await this.#json(`/subscriptions/${encodeURIComponent(existing)}`, this.#jsonInit("PATCH", { expirationDateTime }));
      } catch (err) {
        if (!(err instanceof ProviderHttpError && err.status === 404)) throw err;
      }
    }
    if (!body) {
      body = await this.#json("/subscriptions", this.#jsonInit("POST", {
        changeType: "created,updated,deleted",
        notificationUrl: webhookUrl,
        lifecycleNotificationUrl: webhookUrl,
        resource: "/me/messages",
        expirationDateTime,
        clientState,
      }));
    }
    if (typeof body?.id !== "string") throw new Error("Graph subscription response has no id");
    this.#subscriptionId = body.id;
    const expiresAt = typeof body.expirationDateTime === "string" ? body.expirationDateTime : expirationDateTime;
    return { expiresAt, state: { subscriptionId: body.id } };
  }

  async stopPush(): Promise<void> {
    if (!this.#opts.webhookUrl) return;
    const existing = await this.#findSubscription();
    if (!existing) return;
    try {
      await this.#request(`/subscriptions/${encodeURIComponent(existing)}`, { method: "DELETE" });
    } catch (err) {
      if (!(err instanceof ProviderHttpError && err.status === 404)) throw err;
    }
    this.#subscriptionId = undefined;
  }

  /** Microsoft has no per-app revoke for delegated users. */
  async revoke(): Promise<boolean> {
    return false;
  }
}
