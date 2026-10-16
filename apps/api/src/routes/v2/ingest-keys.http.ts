import { HttpApiBuilder } from "effect/http-api"
import type { CustomIngestKey, IngestKeysResponse } from "@maple/domain/http"
import { CreateCustomIngestKeyRequest, CurrentTenant, UpdateCustomIngestKeyRequest } from "@maple/domain/http"
import {
	MapleApiV2,
	paginateArray,
	timestamp,
	timestampOrNull,
	V2InsufficientPermissions,
} from "@maple/domain/http/v2"
import type { V2CustomIngestKey, V2IngestKeys } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { OrgCustomIngestKeysService } from "@maple/backend/services/org/OrgCustomIngestKeysService"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { requireAdmin } from "@maple/backend/services/auth/auth"
import { timestampMs } from "@maple/backend/platform/time"
import { diffAuditChanges, pickPresentFields } from "@/routes/v2/audit-changes"

const adminOnly = (action: string) => () =>
	V2InsufficientPermissions.make(`Only org admins can ${action} ingest keys`)

const toV2IngestKeys = (keys: IngestKeysResponse): V2IngestKeys => ({
	object: "ingest_keys",
	public_key: keys.publicKey,
	private_key: keys.privateKey,
	public_rotated_at: keys.publicRotatedAt,
	private_rotated_at: keys.privateRotatedAt,
})

const toV2CustomIngestKey = (key: CustomIngestKey): V2CustomIngestKey => ({
	id: key.id,
	object: "custom_ingest_key",
	name: key.name,
	description: key.description,
	key_prefix: key.keyPrefix,
	enabled: key.enabled,
	allowed_signals: key.allowedSignals,
	rate_limit_rps: key.rateLimitRps,
	resource_attributes: key.resourceAttributes,
	expires_at: timestampOrNull(key.expiresAt),
	rolled_at: timestamp(key.rolledAt),
	created_at: timestamp(key.createdAt),
	updated_at: timestamp(key.updatedAt),
})

/** Update-payload fields that are diffable through the wire shape. */
const customKeyAuditKeys: ReadonlyArray<
	| "name"
	| "description"
	| "enabled"
	| "allowed_signals"
	| "rate_limit_rps"
	| "resource_attributes"
	| "expires_at"
> = [
	"name",
	"description",
	"enabled",
	"allowed_signals",
	"rate_limit_rps",
	"resource_attributes",
	"expires_at",
]

export const HttpV2IngestKeysLive = HttpApiBuilder.group(MapleApiV2, "ingestKeys", (handlers) =>
	Effect.gen(function* () {
		const ingestKeys = yield* OrgIngestKeysService
		const customKeys = yield* OrgCustomIngestKeysService

		const adminTenant = (action: string) =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				yield* requireAdmin(tenant.roles, adminOnly(action))
				return tenant
			})

		return handlers
			.handle("retrieve", () =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("view")
					const keys = yield* ingestKeys.getOrCreate(tenant.orgId, tenant.userId)

					return toV2IngestKeys(keys)
				}),
			)
			.handle("rollPublic", () =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("roll")
					const keys = yield* ingestKeys.rerollPublic(tenant.orgId, tenant.userId)
					yield* recordHttpAudit("ingest_key.rolled", {
						metadata: { key_type: "public" },
					})

					return toV2IngestKeys(keys)
				}),
			)
			.handle("rollPrivate", () =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("roll")
					const keys = yield* ingestKeys.rerollPrivate(tenant.orgId, tenant.userId)
					yield* recordHttpAudit("ingest_key.rolled", {
						metadata: { key_type: "private" },
					})

					return toV2IngestKeys(keys)
				}),
			)
			.handle("listCustom", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("view")
					const keys = yield* customKeys.list(tenant.orgId)
					const page = yield* paginateArray(keys.map(toV2CustomIngestKey), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieveCustom", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("view")
					return toV2CustomIngestKey(yield* customKeys.get(tenant.orgId, params.id))
				}),
			)
			.handle("createCustom", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("create")
					const created = yield* customKeys.create(
						tenant.orgId,
						tenant.userId,
						new CreateCustomIngestKeyRequest({
							name: payload.name,
							...(payload.description !== undefined
								? { description: payload.description }
								: undefined),
							...(payload.enabled !== undefined ? { enabled: payload.enabled } : undefined),
							...(payload.allowed_signals !== undefined
								? { allowedSignals: payload.allowed_signals }
								: undefined),
							...(payload.rate_limit_rps !== undefined
								? { rateLimitRps: payload.rate_limit_rps }
								: undefined),
							...(payload.resource_attributes !== undefined
								? { resourceAttributes: payload.resource_attributes }
								: undefined),
							...(payload.expires_at !== undefined
								? {
										expiresAtMs:
											payload.expires_at === null
												? null
												: timestampMs(payload.expires_at),
									}
								: undefined),
						}),
					)
					yield* recordHttpAudit("custom_ingest_key.created", {
						resourceId: created.key.id,
						metadata: { name: created.key.name },
					})

					return { ...toV2CustomIngestKey(created.key), secret: created.secret }
				}),
			)
			.handle("updateCustom", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("update")
					const current = yield* customKeys.get(tenant.orgId, params.id)
					const updated = yield* customKeys.update(
						tenant.orgId,
						tenant.userId,
						params.id,
						new UpdateCustomIngestKeyRequest({
							...(payload.name !== undefined ? { name: payload.name } : undefined),
							...(payload.description !== undefined
								? { description: payload.description }
								: undefined),
							...(payload.enabled !== undefined ? { enabled: payload.enabled } : undefined),
							...(payload.allowed_signals !== undefined
								? { allowedSignals: payload.allowed_signals }
								: undefined),
							...(payload.rate_limit_rps !== undefined
								? { rateLimitRps: payload.rate_limit_rps }
								: undefined),
							...(payload.resource_attributes !== undefined
								? { resourceAttributes: payload.resource_attributes }
								: undefined),
							...(payload.expires_at !== undefined
								? {
										expiresAtMs:
											payload.expires_at === null
												? null
												: timestampMs(payload.expires_at),
									}
								: undefined),
						}),
					)
					yield* recordHttpAudit("custom_ingest_key.updated", {
						resourceId: updated.id,
						changes: diffAuditChanges(
							pickPresentFields(customKeyAuditKeys, payload, toV2CustomIngestKey(current)),
							pickPresentFields(customKeyAuditKeys, payload, toV2CustomIngestKey(updated)),
						),
						metadata: { name: updated.name },
					})

					return toV2CustomIngestKey(updated)
				}),
			)
			.handle("rollCustom", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("roll")
					const rolled = yield* customKeys.roll(tenant.orgId, tenant.userId, params.id)
					yield* recordHttpAudit("custom_ingest_key.rolled", {
						resourceId: rolled.key.id,
						metadata: { name: rolled.key.name },
					})

					return { ...toV2CustomIngestKey(rolled.key), secret: rolled.secret }
				}),
			)
			.handle("deleteCustom", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("delete")
					const deleted = yield* customKeys.delete(tenant.orgId, params.id)
					yield* recordHttpAudit("custom_ingest_key.deleted", {
						resourceId: deleted.id,
						metadata: { name: deleted.name },
					})

					return { id: deleted.id, object: "custom_ingest_key" as const, deleted: true as const }
				}),
			)
	}),
)
