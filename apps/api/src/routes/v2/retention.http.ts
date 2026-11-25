import { HttpApiBuilder } from "effect/http-api"
import {
	CurrentTenant,
	type OrgId,
	RetentionInvalidError,
	RetentionPersistenceError,
} from "@maple/domain/http"
import {
	encodePublicId,
	MapleApiV2,
	PublicIdPrefixes,
	type V2RetentionDays,
	type V2RetentionPolicy,
	type V2SourceRetentionUpdateParams,
} from "@maple/domain/http/v2"
import {
	DEFAULT_RETENTION_DAYS,
	RETENTION_PERIODS,
	RETENTION_SIGNALS,
	type RetentionDaysBySignal,
	type RetentionOverrides,
} from "@maple/domain/retention"
import { Array as Arr, Effect, Option } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { type RetentionPolicy, RetentionService } from "@maple/backend/services/retention/RetentionService"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { diffAuditChanges } from "@/routes/v2/audit-changes"

const toDays = (days: RetentionDaysBySignal): V2RetentionDays => ({
	traces: days.traces,
	logs: days.logs,
	metrics: days.metrics,
	sessions: days.sessions,
	events: days.events,
	profiles: days.profiles,
})

const toSet = (overrides: RetentionOverrides) => ({
	traces: overrides.traces ?? null,
	logs: overrides.logs ?? null,
	metrics: overrides.metrics ?? null,
	sessions: overrides.sessions ?? null,
	events: overrides.events ?? null,
	profiles: overrides.profiles ?? null,
})

export const toV2RetentionPolicy = (
	policy: RetentionPolicy,
	storage: V2RetentionPolicy["storage"],
): V2RetentionPolicy => ({
	object: "retention_policy",
	storage,
	periods: RETENTION_PERIODS,
	defaults: toDays(DEFAULT_RETENTION_DAYS),
	organization: { set: toSet(policy.overrides), days: toDays(policy.days) },
	read_horizon_days: toDays(policy.readHorizonDays),
	sources: Arr.map(policy.sources, (source) => ({
		source_id: source.sourceId,
		set: toSet(source.overrides),
		days: toDays(source.days),
	})),
})

/** A PATCH over what is set: a signal given a period sets it, `null` clears it, omitted keeps it. */
export const applyRetentionPatch = (
	current: RetentionOverrides,
	patch: V2SourceRetentionUpdateParams,
): RetentionOverrides => {
	const none: RetentionOverrides = {}
	return Arr.reduce(RETENTION_SIGNALS, none, (next, signal) => {
		const value = signal in patch ? patch[signal] : current[signal]
		return value === null || value === undefined ? next : { ...next, [signal]: value }
	})
}

/** Every signal's set period before and after, `null` where it inherits. */
const auditChanges = (before: RetentionOverrides, after: RetentionOverrides) =>
	diffAuditChanges(toSet(before), toSet(after))

export const HttpV2RetentionLive = HttpApiBuilder.group(MapleApiV2, "retention", (handlers) =>
	Effect.gen(function* () {
		const retention = yield* RetentionService
		const warehouses = yield* OrgClickHouseSettingsService

		/** An org on its own ClickHouse keeps that cluster's retention; Maple's periods do not apply. */
		const storageOf = (orgId: OrgId) =>
			warehouses.resolveRuntimeConfig(orgId).pipe(
				Effect.mapBoth({
					onSuccess: (config): V2RetentionPolicy["storage"] =>
						Option.isSome(config) ? "own_warehouse" : "managed",
					onFailure: (error) =>
						new RetentionPersistenceError({
							message: "Couldn't read where telemetry is stored",
							cause: error.message,
						}),
				}),
			)

		/** Writes are refused for an org whose own ClickHouse keeps its retention. */
		const requireManagedStorage = (orgId: OrgId) =>
			storageOf(orgId).pipe(
				Effect.filterOrFail(
					(storage) => storage === "managed",
					() =>
						new RetentionInvalidError({
							message:
								"This organization stores telemetry in its own ClickHouse, which keeps its own retention. Change it there.",
						}),
				),
			)

		return handlers
			.handle("retrieve", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const policy = yield* retention.get(tenant.orgId)
					const storage = yield* storageOf(tenant.orgId)
					return toV2RetentionPolicy(policy, storage)
				}),
			)
			.handle("update", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const storage = yield* requireManagedStorage(tenant.orgId)
					const { before, policy } = yield* retention.updateOrganization(
						tenant.orgId,
						tenant.userId,
						(current) => applyRetentionPatch(current, payload),
					)
					const changes = auditChanges(before, policy.overrides)
					if (changes !== undefined) yield* recordHttpAudit("retention.updated", { changes })
					return toV2RetentionPolicy(policy, storage)
				}),
			)
			.handle("updateSource", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const storage = yield* requireManagedStorage(tenant.orgId)
					const { before, policy } = yield* retention.updateSource(
						tenant.orgId,
						tenant.userId,
						params.id,
						(current) => applyRetentionPatch(current, payload),
					)
					const after = Option.match(
						Arr.findFirst(policy.sources, (source) => source.sourceId === params.id),
						{ onNone: (): RetentionOverrides => ({}), onSome: (source) => source.overrides },
					)
					const changes = auditChanges(before, after)
					if (changes !== undefined)
						yield* recordHttpAudit("retention.source_updated", {
							changes,
							metadata: { sourceId: encodePublicId(PublicIdPrefixes.source, params.id) },
						})
					return toV2RetentionPolicy(policy, storage)
				}),
			)
	}),
)
