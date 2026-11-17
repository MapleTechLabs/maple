import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, EnterpriseSsoForbiddenError, MapleInternalApi } from "@maple/domain/http"
import { Array as Arr, Effect } from "effect"
import * as Policy from "@maple/domain/policy"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import {
	EnterpriseSsoService,
	normalizeDomain,
} from "@maple/backend/services/org/enterprise-sso/EnterpriseSsoService"

const requireSsoAdmin = Effect.gen(function* () {
	const tenant = yield* CurrentTenant.Context
	yield* Policy.check(
		tenant.roles,
		"sso:manage",
		(denial) => new EnterpriseSsoForbiddenError({ message: denial.message }),
	)
	return tenant
})

// Reads are open to every member (the page says who to ask); every write is admin-only and audited.
// Audit metadata names what changed, never a secret: no client secret, certificate or SCIM token.
export const HttpEnterpriseSsoLive = HttpApiBuilder.group(MapleInternalApi, "enterpriseSso", (handlers) =>
	Effect.gen(function* () {
		const sso = yield* EnterpriseSsoService

		return handlers
			.handle("get", () =>
				CurrentTenant.Context.pipe(
					Effect.flatMap((tenant) => sso.get(tenant.orgId)),
					Effect.withSpan("HttpEnterpriseSso.get"),
				),
			)
			.handle("addDomain", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requireSsoAdmin
					const document = yield* sso.addDomain(tenant.orgId, tenant.userId, payload.domain)
					yield* recordHttpAudit("enterprise_sso.domain_added", {
						metadata: { domain: normalizeDomain(payload.domain) },
					})
					return document
				}).pipe(Effect.withSpan("HttpEnterpriseSso.addDomain")),
			)
			.handle("verifyDomain", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* requireSsoAdmin
					const document = yield* sso.verifyDomain(tenant.orgId, params.domain)
					yield* recordHttpAudit("enterprise_sso.domain_verified", {
						metadata: { domain: normalizeDomain(params.domain) },
					})
					return document
				}).pipe(Effect.withSpan("HttpEnterpriseSso.verifyDomain")),
			)
			.handle("removeDomain", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* requireSsoAdmin
					const document = yield* sso.removeDomain(tenant.orgId, params.domain)
					yield* recordHttpAudit("enterprise_sso.domain_removed", {
						metadata: { domain: normalizeDomain(params.domain) },
					})
					return document
				}).pipe(Effect.withSpan("HttpEnterpriseSso.removeDomain")),
			)
			.handle("createConnection", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requireSsoAdmin
					const document = yield* sso.createConnection(tenant.orgId, tenant.userId, payload)
					yield* recordHttpAudit("enterprise_sso.connection_created", {
						metadata: {
							provider: payload.provider,
							name: payload.name,
							domains: Arr.join(Arr.map(payload.domains, normalizeDomain), ","),
						},
					})
					return document
				}).pipe(Effect.withSpan("HttpEnterpriseSso.createConnection")),
			)
			.handle("updateConnection", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requireSsoAdmin
					const document = yield* sso.updateConnection(tenant.orgId, payload)
					yield* recordHttpAudit("enterprise_sso.connection_updated", {
						metadata: {
							name: payload.name,
							domains: Arr.join(Arr.map(payload.domains, normalizeDomain), ","),
							idpSettingsChanged: payload.saml !== undefined || payload.oidc !== undefined,
						},
					})
					return document
				}).pipe(Effect.withSpan("HttpEnterpriseSso.updateConnection")),
			)
			.handle("setEnforcement", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requireSsoAdmin
					const document = yield* sso.setEnforcement(tenant.orgId, payload.enforced)
					yield* recordHttpAudit(
						payload.enforced
							? "enterprise_sso.connection_enforced"
							: "enterprise_sso.connection_relaxed",
					)
					return document
				}).pipe(Effect.withSpan("HttpEnterpriseSso.setEnforcement")),
			)
			.handle("deleteConnection", () =>
				Effect.gen(function* () {
					const tenant = yield* requireSsoAdmin
					const document = yield* sso.deleteConnection(tenant.orgId)
					yield* recordHttpAudit("enterprise_sso.connection_deleted")
					return document
				}).pipe(Effect.withSpan("HttpEnterpriseSso.deleteConnection")),
			)
			.handle("createDirectory", () =>
				Effect.gen(function* () {
					const tenant = yield* requireSsoAdmin
					const issued = yield* sso.createDirectory(tenant.orgId)
					yield* recordHttpAudit("enterprise_sso.directory_created")
					return issued
				}).pipe(Effect.withSpan("HttpEnterpriseSso.createDirectory")),
			)
			.handle("rotateDirectoryToken", () =>
				Effect.gen(function* () {
					const tenant = yield* requireSsoAdmin
					const issued = yield* sso.rotateDirectoryToken(tenant.orgId)
					yield* recordHttpAudit("enterprise_sso.directory_key_rotated")
					return issued
				}).pipe(Effect.withSpan("HttpEnterpriseSso.rotateDirectoryToken")),
			)
			.handle("setDirectoryState", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requireSsoAdmin
					const document = yield* sso.setDirectoryState(tenant.orgId, payload.paused)
					yield* recordHttpAudit(
						payload.paused
							? "enterprise_sso.directory_paused"
							: "enterprise_sso.directory_resumed",
					)
					return document
				}).pipe(Effect.withSpan("HttpEnterpriseSso.setDirectoryState")),
			)
			.handle("deleteDirectory", () =>
				Effect.gen(function* () {
					const tenant = yield* requireSsoAdmin
					const document = yield* sso.deleteDirectory(tenant.orgId)
					yield* recordHttpAudit("enterprise_sso.directory_deleted")
					return document
				}).pipe(Effect.withSpan("HttpEnterpriseSso.deleteDirectory")),
			)
			.handle("setRoleMappings", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requireSsoAdmin
					const document = yield* sso.setRoleMappings(tenant.orgId, payload.mappings)
					yield* recordHttpAudit("enterprise_sso.role_mapping_updated", {
						metadata: {
							mappings: Arr.join(
								Arr.map(payload.mappings, (m) => `${m.groupId}=${m.role}`),
								",",
							),
						},
					})
					return document
				}).pipe(Effect.withSpan("HttpEnterpriseSso.setRoleMappings")),
			)
			.handle("addBypassUser", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requireSsoAdmin
					const document = yield* sso.addBypassUser(tenant.orgId, payload.userId)
					yield* recordHttpAudit("enterprise_sso.bypass_added", { affectedUserId: payload.userId })
					return document
				}).pipe(Effect.withSpan("HttpEnterpriseSso.addBypassUser")),
			)
			.handle("removeBypassUser", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* requireSsoAdmin
					const document = yield* sso.removeBypassUser(tenant.orgId, params.userId)
					yield* recordHttpAudit("enterprise_sso.bypass_removed", { affectedUserId: params.userId })
					return document
				}).pipe(Effect.withSpan("HttpEnterpriseSso.removeBypassUser")),
			)
	}),
)
