import { HttpApiBuilder } from "effect/http-api"
import {
	AlertSilenceCreateRequest,
	AlertSilenceUpdateRequest,
	CurrentTenant,
	IsoDateTimeString,
	type AlertSilenceDocument,
	type AlertSilenceMatchers,
} from "@maple/domain/http"
import type {
	V2AlertSilence,
	V2AlertSilenceMatchers,
	V2AlertSilenceUpdateParams,
} from "@maple/domain/http/v2"
import { MapleApiV2, paginateOffsetQuery, timestamp, V2ParameterInvalid } from "@maple/domain/http/v2"
import { Array as Arr, Clock, DateTime, Effect, Schema } from "effect"
import { auditDiff } from "@/routes/v2/audit-changes"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { AlertSilencesService } from "@maple/backend/services/alerts/AlertSilencesService"
import { timestampMs } from "@maple/backend/platform/time"

const decodeIso = (value: string, param: string) =>
	Schema.decodeEffect(IsoDateTimeString)(value).pipe(
		Effect.mapError(() => V2ParameterInvalid.make("Expected an ISO-8601 UTC timestamp.", { param })),
	)

const silenceAuditDiff = auditDiff<keyof V2AlertSilenceUpdateParams & keyof V2AlertSilence>({
	fields: ["reason", "matchers", "starts_at", "ends_at"],
})

export const toMatchers = (matchers: V2AlertSilenceMatchers): AlertSilenceMatchers => ({
	...(matchers.rule_ids === undefined ? undefined : { ruleIds: matchers.rule_ids }),
	...(matchers.tags === undefined ? undefined : { tags: matchers.tags }),
	...(matchers.services === undefined ? undefined : { services: matchers.services }),
	...(matchers.environments === undefined ? undefined : { environments: matchers.environments }),
})

export const fromMatchers = (matchers: AlertSilenceMatchers): V2AlertSilenceMatchers => ({
	...(matchers.ruleIds === undefined ? undefined : { rule_ids: matchers.ruleIds }),
	...(matchers.tags === undefined ? undefined : { tags: matchers.tags }),
	...(matchers.services === undefined ? undefined : { services: matchers.services }),
	...(matchers.environments === undefined ? undefined : { environments: matchers.environments }),
})

export const hasMatcher = (matchers: V2AlertSilenceMatchers) =>
	(matchers.rule_ids?.length ?? 0) +
		(matchers.tags?.length ?? 0) +
		(matchers.services?.length ?? 0) +
		(matchers.environments?.length ?? 0) >
	0

const requireMatcher = (matchers: V2AlertSilenceMatchers) =>
	hasMatcher(matchers)
		? Effect.void
		: Effect.fail(
				V2ParameterInvalid.make("A silence needs at least one rule, tag, service or environment.", {
					param: "matchers",
				}),
			)

export const toV2Silence = (doc: AlertSilenceDocument): V2AlertSilence => ({
	id: doc.id,
	object: "alert_silence",
	reason: doc.reason,
	matchers: fromMatchers(doc.matchers),
	status: doc.status,
	starts_at: timestamp(doc.startsAt),
	ends_at: timestamp(doc.endsAt),
	maintenance_window_id: doc.maintenanceWindowId,
	created_by: doc.createdBy,
	created_at: timestamp(doc.createdAt),
	updated_at: timestamp(doc.updatedAt),
})

export const HttpV2AlertSilencesLive = HttpApiBuilder.group(MapleApiV2, "alertSilences", (handlers) =>
	Effect.gen(function* () {
		const silences = yield* AlertSilencesService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const page = yield* paginateOffsetQuery(query, ({ limit, offset }) =>
						silences
							.list(tenant.orgId, {
								...(query.status === undefined ? undefined : { status: query.status }),
								...(query.maintenance_window_id === undefined
									? undefined
									: { maintenanceWindowId: query.maintenance_window_id }),
								limit,
								offset,
							})
							.pipe(Effect.map((response) => Arr.map(response.silences, toV2Silence))),
					)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const silence = yield* silences.get(tenant.orgId, params.id)
					return toV2Silence(silence)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireMatcher(payload.matchers)
					if ((payload.ends_at === undefined) === (payload.duration_minutes === undefined)) {
						return yield* V2ParameterInvalid.make(
							"Give exactly one of ends_at and duration_minutes.",
							{
								param: payload.ends_at === undefined ? "ends_at" : "duration_minutes",
							},
						)
					}
					// The start is always sent, so a duration counts from exactly the start the silence gets.
					const nowMs = yield* Clock.currentTimeMillis
					const startsAtMs =
						payload.starts_at === undefined ? nowMs : timestampMs(payload.starts_at)
					const endsAt = yield* decodeIso(
						payload.ends_at ??
							DateTime.formatIso(
								DateTime.makeUnsafe(startsAtMs + (payload.duration_minutes ?? 0) * 60_000),
							),
						payload.ends_at === undefined ? "duration_minutes" : "ends_at",
					)
					const startsAt = yield* decodeIso(
						payload.starts_at ?? DateTime.formatIso(DateTime.makeUnsafe(startsAtMs)),
						"starts_at",
					)
					const created = yield* silences.create(
						tenant.orgId,
						tenant.userId,
						tenant.roles,
						new AlertSilenceCreateRequest({
							reason: payload.reason,
							matchers: toMatchers(payload.matchers),
							startsAt,
							endsAt,
						}),
					)
					yield* recordHttpAudit("alert_silence.created", {
						resourceId: created.id,
						metadata: { reason: created.reason, endsAt: created.endsAt },
					})
					return toV2Silence(created)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					if (payload.matchers !== undefined) yield* requireMatcher(payload.matchers)
					const current = yield* silences.get(tenant.orgId, params.id)
					const startsAt =
						payload.starts_at === undefined
							? undefined
							: yield* decodeIso(payload.starts_at, "starts_at")
					const endsAt =
						payload.ends_at === undefined
							? undefined
							: yield* decodeIso(payload.ends_at, "ends_at")
					const updated = yield* silences.update(
						tenant.orgId,
						tenant.userId,
						tenant.roles,
						params.id,
						new AlertSilenceUpdateRequest({
							...(payload.reason === undefined ? undefined : { reason: payload.reason }),
							...(payload.matchers === undefined
								? undefined
								: { matchers: toMatchers(payload.matchers) }),
							...(startsAt === undefined ? undefined : { startsAt }),
							...(endsAt === undefined ? undefined : { endsAt }),
						}),
					)
					yield* recordHttpAudit("alert_silence.updated", {
						resourceId: updated.id,
						changes: silenceAuditDiff(payload, toV2Silence(current), toV2Silence(updated)),
						metadata: { reason: updated.reason },
					})
					return toV2Silence(updated)
				}),
			)
			.handle("end", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const ended = yield* silences.end(tenant.orgId, tenant.userId, tenant.roles, params.id)
					yield* recordHttpAudit("alert_silence.ended", {
						resourceId: ended.id,
						metadata: { reason: ended.reason },
					})
					return toV2Silence(ended)
				}),
			)
	}),
)
