import { writeFileSync } from "node:fs";
import { z } from "zod";
import { authRoutes } from "../src/server/routes/auth";
import { mailRoutes } from "../src/server/routes/mail";
import { orgRoutes } from "../src/server/routes/org";
import { webhookRoutes } from "../src/server/routes/webhooks";
import { identityRoutes } from "../src/server/routes/identity";
import { scimRoutes } from "../src/server/routes/scim";
import { operatorRoutes } from "../src/server/routes/operator";

/** Generated from the routes actually mounted, so this can't drift from what the server does. */
const groups = { auth: authRoutes, mail: mailRoutes, organization: orgRoutes, webhooks: webhookRoutes, operator: operatorRoutes, identity: identityRoutes, scim: scimRoutes };
const paths: Record<string, Record<string, unknown>> = {};
let count = 0;
for (const [tag, routes] of Object.entries(groups)) {
  for (const r of routes) {
    const path = `/api/v1${r.p.replace(/:(\w+)/g, "{$1}")}`;
    const params = [...r.p.matchAll(/:(\w+)/g)].map(m => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    const op: Record<string, unknown> = {
      tags: [tag],
      // Operator routes check the session themselves, so non-operators get the same 404 as a missing path.
      security: r.auth === false && tag !== "operator" ? [] : [{ session: [] }],
      responses: { 200: { description: "OK" }, 400: { description: "Invalid" }, 401: { description: "Not signed in" }, 403: { description: "Forbidden, or request from another origin" }, 404: { description: "Not found or not accessible. Foreign IDs look identical to missing ones." }, 429: { description: "Rate limited" } },
    };
    if (r.body) op.requestBody = { required: true, content: { "application/json": { schema: z.toJSONSchema(r.body, { unrepresentable: "any" }) } } };
    const q = r.query ? Object.entries((z.toJSONSchema(r.query, { unrepresentable: "any" }) as { properties?: Record<string, unknown> }).properties ?? {}).map(([name, schema]) => ({ name, in: "query", schema })) : [];
    if (params.length || q.length) op.parameters = [...params, ...q];
    (paths[path] ??= {})[r.m.toLowerCase()] = op;
    count++;
  }
}
const doc = { openapi: "3.1.0", info: { title: "Aegis Mail API", version: "1", description: "State-changing requests must carry the app's Origin. Send requires an idempotency key." }, components: { securitySchemes: { session: { type: "apiKey", in: "cookie", name: "aegis_session" } } }, paths };
writeFileSync(new URL("../../../docs/openapi.json", import.meta.url), JSON.stringify(doc, null, 2));
console.log(`Wrote docs/openapi.json with ${count} operations`);
process.exit(0);
