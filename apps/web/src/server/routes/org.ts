import { InviteBody, IncidentShareBody, PolicyBody } from "@aegis/domain";
import * as P from "@aegis/platform";
import { AppError } from "@aegis/platform";
import { resolveTxt } from "node:dns/promises";
import { z } from "zod";
import { platform } from "../platform";
import type { RouteDef } from "../router";

/**
 * Organization console. These routes return members, policies and aggregates. None of them read message content: that's
 * enforced by the database role, and a static test forbids mail reads in this file.
 */
export const orgRoutes: RouteDef[] = [
  { m: "GET", p: "/org/members", h: async ({ ctx }) => P.listMembers(platform(), ctx) },
  { m: "PATCH", p: "/org/members/:id", body: z.object({ role: z.enum(["owner", "security_admin", "workspace_manager", "member"]) }), h: async ({ ctx, params, body }) => { await P.changeRole(platform(), ctx, params.id!, body.role); return { ok: true }; } },
  { m: "DELETE", p: "/org/members/:id", h: async ({ ctx, params }) => { await P.removeMember(platform(), ctx, params.id!); return { ok: true }; } },
  { m: "GET", p: "/org/invites", h: async ({ ctx }) => P.listInvites(platform(), ctx) },
  { m: "POST", p: "/org/invites", body: InviteBody, h: async ({ ctx, body }) => { await P.checkSeatLimit(platform(), ctx); return P.invite(platform(), ctx, body); } },
  { m: "DELETE", p: "/org/invites/:id", h: async ({ ctx, params }) => { await P.withdrawInvite(platform(), ctx, params.id!); return { ok: true }; } },
  { m: "POST", p: "/invites/:token/accept", h: async ({ session, params }) => P.acceptInvite(platform(), session.userId, session.email, params.token!) },
  { m: "GET", p: "/org/policy", h: async ({ ctx }) => P.getPolicy(platform(), ctx) },
  { m: "PATCH", p: "/org/policy", body: PolicyBody.extend({ retentionDays: z.number().int().min(1).max(3650).nullable().optional(), hostedModelsDisabled: z.boolean().optional() }), h: async ({ ctx, body }) => { await P.updatePolicy(platform(), ctx, body as never); return { ok: true }; } },
  { m: "GET", p: "/org/security", query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), h: async ({ ctx, query }) => P.securityOverview(platform(), ctx, query.days) },
  { m: "POST", p: "/org/keys/rotate", h: async ({ ctx }) => { await P.rotateTenantKeys(platform(), ctx); return { ok: true }; } },
  { m: "GET", p: "/org/audit", query: z.object({ before: z.coerce.number().int().positive().optional() }), h: async ({ ctx, query }) => P.auditLog(platform(), ctx, 100, query.before) },
  { m: "GET", p: "/org/grants", h: async ({ ctx }) => P.listGrants(platform(), ctx) },
  { m: "POST", p: "/org/grants", body: z.object({ accountId: z.string().uuid(), granteeUserId: z.string().uuid(), canSend: z.boolean().optional() }), h: async ({ ctx, body }) => { await P.grantMailbox(platform(), ctx, body.accountId, body.granteeUserId, { canSend: body.canSend }); return { ok: true }; } },
  { m: "POST", p: "/org/grants/revoke", body: z.object({ accountId: z.string().uuid(), granteeUserId: z.string().uuid() }), h: async ({ ctx, body }) => { await P.revokeMailboxGrant(platform(), ctx, body.accountId, body.granteeUserId); return { ok: true }; } },
  { m: "GET", p: "/org/incidents", h: async ({ ctx }) => P.listIncidents(platform(), ctx) },
  { m: "POST", p: "/incidents", body: IncidentShareBody, h: async ({ ctx, body }) => P.shareIncident(platform(), ctx, body) },
  { m: "POST", p: "/incidents/:id/revoke", h: async ({ ctx, params }) => { await P.revokeIncident(platform(), ctx, params.id!); return { ok: true }; } },
  { m: "GET", p: "/org/domains", h: async ({ ctx }) => P.listDomains(platform(), ctx) },
  { m: "POST", p: "/org/domains", body: z.object({ domain: z.string().max(253) }), h: async ({ ctx, body }) => P.addDomain(platform(), ctx, body.domain) },
  { m: "POST", p: "/org/domains/verify", body: z.object({ domain: z.string().max(253) }), h: async ({ ctx, body }) => { await P.verifyDomain(platform(), ctx, body.domain, resolveTxt); return { ok: true }; } },
  { m: "GET", p: "/limits", h: async ({ ctx }) => P.getLimits(platform(), ctx) },
];
void AppError;
