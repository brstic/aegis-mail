import { authenticateScim, errorCode, ScimError, type ScimAuth, scimCreateUser, scimDeleteUser, scimGetUser, scimListUsers, scimPatchUser, scimResourceTypes, scimServiceProviderConfig } from "@aegis/platform";
import { platform } from "../platform";
import { clientKey, readLimited, type RouteDef } from "../router";

const scimResponse = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/scim+json", "Cache-Control": "no-store" } });

/** Authenticated by bearer token only: no session, and no Origin check, since these come from an identity provider. */
function scim(fn: (a: ScimAuth, req: Request, params: Record<string, string>) => Promise<{ body: unknown; status?: number }>): RouteDef["h"] {
  return async ({ req, params }) => {
    const p = platform();
    try {
      const a = await authenticateScim(p, req.headers.get("authorization"), await clientKey());
      const r = await fn(a, req, params);
      return scimResponse(r.body, r.status ?? 200);
    } catch (e) {
      if (e instanceof ScimError) return scimResponse(e.body(), e.status);
      p.log.error("scim.error", { errorCode: errorCode(e) });
      return scimResponse(new ScimError(500, "Something went wrong on our side.").body(), 500);
    }
  };
}

async function jsonBody(req: Request) {
  try { return JSON.parse(await readLimited(req, 1_000_000)); }
  catch { throw new ScimError(400, "Couldn't read that request.", "invalidSyntax"); }
}

const BASE = "/scim/v2";
export const scimRoutes: RouteDef[] = [
  { m: "GET", p: `${BASE}/ServiceProviderConfig`, auth: false, skipOrigin: true, h: scim(async () => ({ body: scimServiceProviderConfig(platform()) })) },
  { m: "GET", p: `${BASE}/ResourceTypes`, auth: false, skipOrigin: true, h: scim(async () => ({ body: scimResourceTypes(platform()) })) },
  { m: "GET", p: `${BASE}/Users`, auth: false, skipOrigin: true, h: scim(async (a, req) => {
    const q = new URL(req.url).searchParams;
    return { body: await scimListUsers(platform(), a, { filter: q.get("filter"), startIndex: Number(q.get("startIndex")) || 1, count: q.has("count") ? Number(q.get("count")) : undefined }) };
  }) },
  { m: "POST", p: `${BASE}/Users`, auth: false, skipOrigin: true, h: scim(async (a, req) => ({ body: await scimCreateUser(platform(), a, await jsonBody(req)), status: 201 })) },
  { m: "GET", p: `${BASE}/Users/:scimId`, auth: false, skipOrigin: true, h: scim(async (a, _req, params) => ({ body: await scimGetUser(platform(), a, params.scimId!) })) },
  { m: "PATCH", p: `${BASE}/Users/:scimId`, auth: false, skipOrigin: true, h: scim(async (a, req, params) => ({ body: await scimPatchUser(platform(), a, params.scimId!, await jsonBody(req)) })) },
  { m: "DELETE", p: `${BASE}/Users/:scimId`, auth: false, skipOrigin: true, h: scim(async (a, _req, params) => { await scimDeleteUser(platform(), a, params.scimId!); return { body: null, status: 204 }; }) },
];
