import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, IngestRuleForbiddenError } from "@maple/domain/http"
import type { IngestRule } from "@maple/domain/ingest-rules"
import {
	MapleApiV2,
	fromV2IngestRuleAction,
	paginateArray,
	toV2IngestRuleAction,
	V2ParameterInvalid,
	type V2IngestRule,
} from "@maple/domain/http/v2"
import { Clock, DateTime, Effect } from "effect"
import { timestampMs } from "@maple/backend/platform/time"
import { requireAdmin } from "@maple/backend/services/auth/auth"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { IngestRuleService } from "@maple/backend/services/org/IngestRuleService"
import { diffAuditChanges, pickPresentFields } from "@/routes/v2/audit-changes"

const isoTimestamp = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_STATS_WINDOW_MS = 62 * DAY_MS

const toV2IngestRule = (rule: IngestRule): V2IngestRule => ({
	id: rule.id,
	object: "ingest_rule",
	name: rule.name,
	enabled: rule.enabled,
	position: rule.position,
	signals: rule.spec.signals,
	conditions: rule.spec.conditions,
	action: toV2IngestRuleAction(rule.spec.action),
	created_at: isoTimestamp(rule.createdAt),
	updated_at: isoTimestamp(rule.updatedAt),
})

const ruleAuditKeys: ReadonlyArray<"name" | "enabled" | "position" | "signals" | "conditions" | "action"> = [
	"name",
	"enabled",
	"position",
	"signals",
	"conditions",
	"action",
]

export const HttpV2IngestRulesLive = HttpApiBuilder.group(MapleApiV2, "ingestRules", (handlers) =>
	Effect.gen(function* () {
		const service = yield* IngestRuleService

		// A rule drops or rewrites the whole org's telemetry, so writes are admin-only.
		const requireRuleAdmin = (tenant: CurrentTenant.TenantSchema, action: string) =>
			requireAdmin(
				tenant.roles,
				() =>
					new IngestRuleForbiddenError({
						message: `Only org admins can ${action} ingest rules`,
						...(tenant.roles.length > 0 ? { roles: [...tenant.roles] } : undefined),
					}),
			)

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rules = yield* service.list(tenant.orgId)
					const page = yield* paginateArray(rules.map(toV2IngestRule), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("stats", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const endMs =
						query.end_time === undefined
							? yield* Clock.currentTimeMillis
							: timestampMs(query.end_time)
					const startMs =
						query.start_time === undefined ? endMs - DAY_MS : timestampMs(query.start_time)
					if (!(startMs < endMs) || endMs - startMs > MAX_STATS_WINDOW_MS) {
						return yield* Effect.fail(
							V2ParameterInvalid.make(
								"start_time must be before end_time, at most 62 days apart.",
								{
									param: "start_time",
								},
							),
						)
					}
					const stats = yield* service.stats(tenant.orgId, startMs, endMs)
					const counts = (row: {
						matched: number
						dropped: number
						droppedBytes: number
						redactedValues: number
					}) => ({
						matched: row.matched,
						dropped: row.dropped,
						dropped_bytes: row.droppedBytes,
						redacted_values: row.redactedValues,
					})
					return {
						object: "ingest_rule_stats" as const,
						start_time: isoTimestamp(startMs),
						end_time: isoTimestamp(endMs),
						rules: stats.rules.map((row) => ({ id: row.ruleId, ...counts(row) })),
						signals: stats.signals.flatMap((row) =>
							row.signal === "traces" || row.signal === "logs" || row.signal === "metrics"
								? [{ signal: row.signal, ...counts(row) }]
								: [],
						),
						hourly: stats.hourly.map((row) => ({
							id: row.ruleId,
							bucket: isoTimestamp(row.bucket),
							matched: row.matched,
						})),
					}
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return toV2IngestRule(yield* service.get(tenant.orgId, params.id))
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireRuleAdmin(tenant, "create")
					const created = yield* service.create(tenant.orgId, {
						name: payload.name,
						enabled: payload.enabled,
						position: payload.position,
						spec: {
							signals: payload.signals,
							conditions: payload.conditions ?? [],
							action: fromV2IngestRuleAction(payload.action),
						},
					})
					yield* recordHttpAudit("ingest_rule.created", {
						resourceId: created.id,
						metadata: { name: created.name, action: created.spec.action._tag },
					})
					return toV2IngestRule(created)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireRuleAdmin(tenant, "update")
					const current = yield* service.get(tenant.orgId, params.id)
					const specChanged =
						payload.signals !== undefined ||
						payload.conditions !== undefined ||
						payload.action !== undefined
					const updated = yield* service.update(tenant.orgId, params.id, {
						name: payload.name,
						enabled: payload.enabled,
						position: payload.position,
						spec: specChanged
							? {
									signals: payload.signals ?? current.spec.signals,
									conditions: payload.conditions ?? current.spec.conditions,
									action:
										payload.action === undefined
											? current.spec.action
											: fromV2IngestRuleAction(payload.action),
								}
							: undefined,
					})
					const changes = diffAuditChanges(
						pickPresentFields(ruleAuditKeys, payload, toV2IngestRule(current)),
						pickPresentFields(ruleAuditKeys, payload, toV2IngestRule(updated)),
					)
					yield* recordHttpAudit("ingest_rule.updated", {
						resourceId: updated.id,
						changes,
						metadata: { name: updated.name },
					})
					return toV2IngestRule(updated)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireRuleAdmin(tenant, "delete")
					const id = yield* service.delete(tenant.orgId, params.id)
					yield* recordHttpAudit("ingest_rule.deleted", { resourceId: id })
					return { id, object: "ingest_rule" as const, deleted: true as const }
				}),
			)
	}),
)
