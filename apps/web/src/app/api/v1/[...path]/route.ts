import { dispatcher } from "@/server/router";
import { authRoutes } from "@/server/routes/auth";
import { mailRoutes } from "@/server/routes/mail";
import { orgRoutes } from "@/server/routes/org";
import { webhookRoutes } from "@/server/routes/webhooks";
import { operatorRoutes } from "@/server/routes/operator";
import { identityRoutes } from "@/server/routes/identity";
import { scimRoutes } from "@/server/routes/scim";

const handler = dispatcher([...authRoutes, ...mailRoutes, ...orgRoutes, ...webhookRoutes, ...operatorRoutes, ...identityRoutes, ...scimRoutes]);
export const dynamic = "force-dynamic";
export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
