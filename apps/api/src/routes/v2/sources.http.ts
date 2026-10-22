import { HttpApiBuilder } from "effect/http-api"
import type { Source } from "@maple/domain/http"
import { CreateSourceRequest, CurrentTenant, UpdateSourceRequest } from "@maple/domain/http"
import {
	GcpConnectorPublicId,
	MapleApiV2,
	paginateArray,
	ScrapeTargetPublicId,
	SourcePublicId,
	timestamp,
	timestampOrNull,
	V2InsufficientPermissions,
} from "@maple/domain/http/v2"
import type { V2Source, V2SourceDeleteResponse, V2SourceUpdateParams } from "@maple/domain/http/v2"
import { GcpConnectorId, ScrapeTargetId } from "@maple/domain/primitives"
import { Effect, Option, Schema } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { SourceUsageService } from "@maple/backend/services/org/SourceUsageService"
import { SourcesService } from "@maple/backend/services/org/SourcesService"
import { SourceRemovalService } from "@maple/backend/services/integrations/SourceRemovalService"
import { requireAdmin } from "@maple/backend/services/auth/auth"
import { timestampMs } from "@maple/backend/platform/time"
import { diffAuditChanges, pickPresentFields } from "@/routes/v2/audit-changes"

const encodePublicSourceId = Schema.encodeSync(SourcePublicId)
const decodePublicSourceId = Schema.decodeUnknownOption(SourcePublicId)
const toIsoTimestamp = (epochMs: number) => timestamp(new Date(epochMs).toISOString())

const adminOnly = (action: string) => () =>
	V2InsufficientPermissions.make(`Only org admins can ${action} sources`)

const decodeScrapeTargetId = Schema.decodeUnknownOption(ScrapeTargetId)
const decodeGcpConnectorId = Schema.decodeUnknownOption(GcpConnectorId)
const encodeScrapeTargetId = Schema.encodeSync(ScrapeTargetPublicId)
const encodeGcpConnectorId = Schema.encodeSync(GcpConnectorPublicId)

/** The id a client can look the integration record up by: its public form where the API has one. */
export const integrationIdOf = (source: Source): string | null => {
	const raw = source.integrationId
	if (raw === null) return null
	if (source.platform === "prometheus")
		return Option.match(decodeScrapeTargetId(raw), { onNone: () => raw, onSome: encodeScrapeTargetId })
	if (source.platform === "gcp")
		return Option.match(decodeGcpConnectorId(raw), { onNone: () => raw, onSome: encodeGcpConnectorId })
	return raw
}

const toV2Source = (source: Source): V2Source => ({
	id: source.id,
	object: "source",
	name: source.name,
	description: source.description,
	platform: source.platform,
	kind: source.kind,
	is_default: source.kind === "default",
	key_prefix: source.keyPrefix,
	integration_id: integrationIdOf(source),
	status: source.status,
	allowed_signals: source.allowedSignals,
	rate_limit_rps: source.rateLimitRps,
	resource_attributes: source.resourceAttributes,
	expires_at: timestampOrNull(source.expiresAt),
	paused_at: timestampOrNull(source.pausedAt),
	paused_until: timestampOrNull(source.pausedUntil),
	last_used_at: timestampOrNull(source.lastUsedAt),
	rolled_at: timestampOrNull(source.rolledAt),
	created_at: timestamp(source.createdAt),
	updated_at: timestamp(source.updatedAt),
	health: {
		status: source.health.status,
		last_data_at: timestampOrNull(source.health.lastDataAt),
		problem: source.health.problem,
		resources: source.health.resources,
	},
})

/** Optional wire fields shared by create and update, mapped to the service request. */
const toServiceFields = (payload: V2SourceUpdateParams) => ({
	...(payload.description !== undefined ? { description: payload.description } : undefined),
	...(payload.allowed_signals !== undefined ? { allowedSignals: payload.allowed_signals } : undefined),
	...(payload.rate_limit_rps !== undefined ? { rateLimitRps: payload.rate_limit_rps } : undefined),
	...(payload.resource_attributes !== undefined
		? { resourceAttributes: payload.resource_attributes }
		: undefined),
	...(payload.expires_at !== undefined
		? { expiresAtMs: payload.expires_at === null ? null : timestampMs(payload.expires_at) }
		: undefined),
})

/** Update-payload fields that are diffable through the wire shape. */
const sourceAuditKeys: ReadonlyArray<
	"name" | "description" | "allowed_signals" | "rate_limit_rps" | "resource_attributes" | "expires_at"
> = ["name", "description", "allowed_signals", "rate_limit_rps", "resource_attributes", "expires_at"]

export const HttpV2SourcesLive = HttpApiBuilder.group(MapleApiV2, "sources", (handlers) =>
	Effect.gen(function* () {
		const sources = yield* SourcesService
		const sourceUsage = yield* SourceUsageService
		const removal = yield* SourceRemovalService

		const adminTenant = (action: string) =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				yield* requireAdmin(tenant.roles, adminOnly(action))
				return tenant
			})

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("view")
					const keys = yield* sources.list(tenant.orgId)
					const page = yield* paginateArray(keys.map(toV2Source), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("view")
					return toV2Source(yield* sources.get(tenant.orgId, params.id))
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("create")
					const created = yield* sources.create(
						tenant.orgId,
						tenant.userId,
						new CreateSourceRequest({
							name: payload.name,
							platform: payload.platform,
							...toServiceFields(payload),
						}),
					)
					yield* recordHttpAudit("source.created", {
						resourceId: created.source.id,
						metadata: { name: created.source.name },
					})

					return { ...toV2Source(created.source), secret: created.secret }
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("update")
					const current = yield* sources.get(tenant.orgId, params.id)
					const updated = yield* sources.update(
						tenant.orgId,
						tenant.userId,
						params.id,
						new UpdateSourceRequest({
							...(payload.name !== undefined ? { name: payload.name } : undefined),
							...toServiceFields(payload),
						}),
					)
					yield* recordHttpAudit("source.updated", {
						resourceId: updated.id,
						changes: diffAuditChanges(
							pickPresentFields(sourceAuditKeys, payload, toV2Source(current)),
							pickPresentFields(sourceAuditKeys, payload, toV2Source(updated)),
						),
						metadata: { name: updated.name },
					})

					return toV2Source(updated)
				}),
			)
			.handle("pause", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("pause")
					const until = payload.until ?? null
					const paused = yield* sources.pause(
						tenant.orgId,
						tenant.userId,
						params.id,
						until === null ? null : timestampMs(until),
					)
					yield* recordHttpAudit("source.paused", {
						resourceId: paused.id,
						metadata: { name: paused.name, until },
					})

					return toV2Source(paused)
				}),
			)
			.handle("resume", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("resume")
					const resumed = yield* sources.resume(tenant.orgId, tenant.userId, params.id)
					yield* recordHttpAudit("source.resumed", {
						resourceId: resumed.id,
						metadata: { name: resumed.name },
					})

					return toV2Source(resumed)
				}),
			)
			.handle("usage", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("view")
					yield* sources.get(tenant.orgId, params.id)
					const usage = yield* sourceUsage.read(tenant, encodePublicSourceId(params.id))
					return {
						object: "source_usage" as const,
						window_start: toIsoTimestamp(usage.windowStart),
						window_end: toIsoTimestamp(usage.windowEnd),
						buckets: usage.buckets.map((bucket) => ({
							hour: toIsoTimestamp(bucket.hour),
							spans: bucket.spans,
							logs: bucket.logs,
							metrics: bucket.metrics,
							bytes: bucket.bytes,
						})),
					}
				}),
			)
			.handle("usageSummary", () =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("view")
					const summary = yield* sourceUsage.summary(tenant)
					return {
						object: "source_usage_summary" as const,
						window_start: toIsoTimestamp(summary.windowStart),
						window_end: toIsoTimestamp(summary.windowEnd),
						// The rollup keys on the stamped `src_` id; one that does not decode names no source.
						data: summary.totals.flatMap((total) =>
							Option.match(decodePublicSourceId(total.sourceId), {
								onNone: () => [],
								onSome: (id) => [
									{
										source_id: id,
										spans: total.spans,
										logs: total.logs,
										metrics: total.metrics,
										bytes: total.bytes,
									},
								],
							}),
						),
					}
				}),
			)
			.handle("roll", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("roll")
					const rolled = yield* sources.roll(tenant.orgId, tenant.userId, params.id)
					yield* recordHttpAudit("source.rolled", {
						resourceId: rolled.source.id,
						metadata: { name: rolled.source.name },
					})

					return { ...toV2Source(rolled.source), secret: rolled.secret }
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* adminTenant("delete")
					const { source: deleted, cleanupScript } = yield* removal.remove(tenant.orgId, params.id)
					yield* recordHttpAudit("source.deleted", {
						resourceId: deleted.id,
						metadata: { name: deleted.name, platform: deleted.platform, kind: deleted.kind },
					})

					const response: V2SourceDeleteResponse = {
						id: deleted.id,
						object: "source",
						deleted: true,
					}
					return cleanupScript === null ? response : { ...response, cleanup_script: cleanupScript }
				}),
			)
	}),
)
