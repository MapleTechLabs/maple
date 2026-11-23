import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, IngestRuleForbiddenError } from "@maple/domain/http"
import { IngestRuleSignal, type IngestRule } from "@maple/domain/ingest-rules"
import {
	MapleApiV2,
	fromV2IngestRuleAction,
	isoTimestamp,
	missingReadScopes,
	paginateArray,
	toV2IngestRuleAction,
	V2InsufficientScope,
	V2ParameterInvalid,
	type V2IngestRule,
} from "@maple/domain/http/v2"
import { Clock, Effect, Schema, Array as Arr } from "effect"
import { timestampMs } from "@maple/backend/platform/time"
import * as Policy from "@maple/domain/policy"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { IngestRuleService } from "@maple/backend/services/org/IngestRuleService"
import { IngestRulePreviewService } from "@maple/backend/services/org/IngestRulePreviewService"
import { diffAuditChanges, pickPresentFields } from "@/routes/v2/audit-changes"

const DAY_MS = 24 * 60 * 60 * 1000
const isSignal = Schema.is(IngestRuleSignal)
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
		const previews = yield* IngestRulePreviewService

		// A rule drops or rewrites the whole org's telemetry, so writes need ingest_rules:manage.
		const requireRuleWrite = (tenant: CurrentTenant.TenantSchema) =>
			Policy.check(
				tenant.roles,
				"ingest_rules:manage",
				(denial) =>
					new IngestRuleForbiddenError({
						message: denial.message,
						...(tenant.roles.length > 0 ? { roles: [...tenant.roles] } : undefined),
					}),
			)

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rules = yield* service.list(tenant.orgId)
					const page = yield* paginateArray(Arr.map(rules, toV2IngestRule), query)
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
						return yield* V2ParameterInvalid.make(
							"start_time must be before end_time, at most 62 days apart.",
							{
								param: "start_time",
							},
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
					const knownSignals = (
						rows: ReadonlyArray<Parameters<typeof counts>[0] & { readonly signal: string }>,
					) =>
						Arr.flatMap(rows, (row) => {
							const signal = row.signal
							return isSignal(signal) ? [{ signal, ...counts(row) }] : []
						})
					return {
						object: "ingest_rule_stats" as const,
						start_time: isoTimestamp(startMs),
						end_time: isoTimestamp(endMs),
						rules: Arr.map(stats.rules, (row) => ({
							id: row.ruleId,
							...counts(row),
							signals: knownSignals(row.signals),
						})),
						signals: knownSignals(stats.signals),
						hourly: Arr.map(stats.hourly, (row) => ({
							id: row.ruleId,
							bucket: isoTimestamp(row.bucket),
							...counts(row),
						})),
					}
				}),
			)
			.handle("suggestions", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const now = yield* Clock.currentTimeMillis
					const result = yield* previews.suggestions(tenant, now, {
						logs: missingReadScopes(tenant.scopes, ["logs"]).length === 0,
						traces: missingReadScopes(tenant.scopes, ["traces"]).length === 0,
					})
					return {
						object: "ingest_rule_suggestions" as const,
						start_time: isoTimestamp(result.startMs),
						end_time: isoTimestamp(result.endMs),
						data: Arr.map(result.suggestions, (entry) => ({
							signal: entry.signal,
							service_name: entry.serviceName,
							level: entry.level,
							span_name: entry.spanName,
							reason: entry.reason,
							keep_percent: entry.keepPercent,
							records: Math.round(entry.records),
							bytes: Math.round(entry.bytes),
							saved_bytes: Math.round(entry.savedBytes),
							share: entry.share,
						})),
					}
				}),
			)
			.handle("preview", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// The counts answer questions about stored telemetry, so a scoped key must read it.
					const missing = missingReadScopes(
						tenant.scopes,
						Arr.filter(payload.signals, (signal) => signal === "logs" || signal === "traces"),
					)
					if (missing.length > 0) {
						return yield* V2InsufficientScope.make(
							`Previewing this rule requires ${Arr.join(
								Arr.map(missing, (family) => `"${family}:read"`),
								", ",
							)}, because it counts the telemetry it reads.`,
						)
					}
					const now = yield* Clock.currentTimeMillis
					const result = yield* previews.preview(
						tenant,
						{
							signals: payload.signals,
							conditions: payload.conditions ?? [],
							action: fromV2IngestRuleAction(payload.action),
						},
						now,
					)
					return {
						object: "ingest_rule_preview" as const,
						start_time: isoTimestamp(result.startMs),
						end_time: isoTimestamp(result.endMs),
						signals: Arr.map(result.signals, (entry) => ({
							signal: entry.signal,
							scanned_minutes: entry.scannedMinutes,
							stored: entry.stored,
							matched: entry.matched,
							estimated_dropped: entry.estimatedDropped,
							estimated_dropped_bytes: entry.estimatedDroppedBytes,
							services: Arr.map(entry.services, (service) => ({
								service_name: service.serviceName,
								stored: service.stored,
								matched: service.matched,
							})),
						})),
					}
				}),
			)
			.handle("reorder", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireRuleWrite(tenant)
					const rules = yield* service.reorder(tenant.orgId, payload.ids)
					yield* Effect.forEach(
						rules,
						(rule) =>
							recordHttpAudit("ingest_rule.updated", {
								resourceId: rule.id,
								metadata: { name: rule.name, position: String(rule.position) },
							}),
						{ discard: true },
					)
					return { object: "list" as const, data: Arr.map(rules, toV2IngestRule) }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rule = yield* service.get(tenant.orgId, params.id)
					return toV2IngestRule(rule)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireRuleWrite(tenant)
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
					yield* requireRuleWrite(tenant)
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
					yield* requireRuleWrite(tenant)
					const id = yield* service.delete(tenant.orgId, params.id)
					yield* recordHttpAudit("ingest_rule.deleted", { resourceId: id })
					return { id, object: "ingest_rule" as const, deleted: true as const }
				}),
			)
	}),
)
