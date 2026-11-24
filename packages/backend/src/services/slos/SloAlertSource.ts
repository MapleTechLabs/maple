import * as PG from "@maple-dev/effect-orm/postgres"
import { Slos } from "@maple/db/tables"
import { SloPersistenceError, type WarehouseReadError } from "@maple/domain/http"
import type { AlertRuleId, OrgId } from "@maple/primitives"
import type { SloBurnWindow, SloCounts } from "@maple/domain/slo"
import { Array as Arr, Cache, Clock, Context, Data, Duration, Effect, Exit, Layer, Option } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { makeSloPersistenceError } from "./slo-persistence"
import { ALERTING_SYSTEM_USER_ID, systemTenant } from "@maple/backend/services/auth/system-tenant"
import { SloReadService } from "./SloReadService"
import type { SloBatchTarget } from "./slo-reads"

/** What one check of an SLO's burn-rate rule reads. */
export interface SloObservation {
	readonly windows: ReadonlyArray<SloBurnWindow>
	readonly targetPercent: number
	readonly windowDays: number
	/** The SLO window's events, a few minutes old at most; null when they could not be read. */
	readonly totals: SloCounts | null
}

export interface SloAlertSourceApi {
	/** What the SLO that owns `ruleId` reads at `endMs`; `None` when no SLO owns it. */
	readonly observe: (
		orgId: OrgId,
		ruleId: AlertRuleId,
		endMs: number,
	) => Effect.Effect<Option.Option<SloObservation>, SloPersistenceError | WarehouseReadError>
}

/** One tick of one org: every SLO rule checked in it shares a read. */
class TickKey extends Data.Class<{ readonly orgId: OrgId; readonly endMs: number }> {}

/** The budget moves slowly, so the window totals are read this often, not every minute. */
const TOTALS_TTL = Duration.minutes(5)
const TOTALS_RETRY_TTL = Duration.seconds(30)
const BURN_TTL = Duration.minutes(2)

/**
 * The alert evaluator's view of SLOs: its own service, with only the database and the
 * warehouse, so the alerting worker takes on nothing else of the SLO API.
 */
export class SloAlertSource extends Context.Service<SloAlertSource, SloAlertSourceApi>()(
	"@maple/backend/services/slos/SloAlertSource",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "SloAlertSource", makeSloPersistenceError)
			const reads = yield* SloReadService

			/** Every SLO of the org that has a burn-rate rule, keyed for the batch reads by that rule. */
			const targetsOf = Effect.fn("SloAlertSource.targets")(function* (orgId: OrgId) {
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(Slos)
							.select(
								"orgId",
								"alertRuleId",
								"serviceName",
								"environmentsJson",
								"sliJson",
								"targetPercent",
								"windowDays",
							)
							.where(($) => [$.orgId.eq(orgId), $.alertRuleId.isNotNull()]),
					),
				)
				return Arr.flatMap(rows, (row): ReadonlyArray<SloBatchTarget> =>
					row.alertRuleId === null
						? []
						: [
								{
									id: row.alertRuleId,
									orgId: row.orgId,
									serviceName: row.serviceName,
									environments: row.environmentsJson,
									sli: row.sliJson,
									targetPercent: row.targetPercent,
									windowDays: row.windowDays,
								},
							],
				)
			})

			// One Postgres read and one warehouse read per SLI for the whole org and tick, however
			// many SLOs it has; each rule's check then looks its own windows up.
			const burnsByTick = yield* Cache.make({
				capacity: 2048,
				timeToLive: BURN_TTL,
				lookup: (key: TickKey) =>
					Effect.gen(function* () {
						const targets = yield* targetsOf(key.orgId)
						const tenant = systemTenant(key.orgId, ALERTING_SYSTEM_USER_ID)
						const windows = yield* reads.burnBatch(tenant, targets, key.endMs)
						return { targets, windows }
					}),
			})

			// Best effort: without the totals a check still judges the burn, just not a spent budget.
			const totalsByOrg = yield* Cache.makeWith(
				(orgId: OrgId) =>
					Effect.gen(function* () {
						const targets = yield* targetsOf(orgId)
						const nowMs = yield* Clock.currentTimeMillis
						return yield* reads.totalsBatch(
							systemTenant(orgId, ALERTING_SYSTEM_USER_ID),
							targets,
							nowMs,
						)
					}).pipe(
						Effect.tapError((error) =>
							Effect.logWarning("SLO window totals could not be read for alerting").pipe(
								Effect.annotateLogs({ orgId, "error.type": error._tag }),
							),
						),
					),
				{
					capacity: 1024,
					timeToLive: (exit) => (Exit.isSuccess(exit) ? TOTALS_TTL : TOTALS_RETRY_TTL),
				},
			)

			const observe = Effect.fn("SloAlertSource.observe")(function* (
				orgId: OrgId,
				ruleId: AlertRuleId,
				endMs: number,
			) {
				const tick = yield* Cache.get(burnsByTick, new TickKey({ orgId, endMs }))
				const target = Arr.findFirst(tick.targets, (slo) => slo.id === ruleId)
				if (Option.isNone(target)) return Option.none<SloObservation>()
				const totals = yield* Effect.option(Cache.get(totalsByOrg, orgId))
				return Option.some<SloObservation>({
					windows: tick.windows.get(ruleId) ?? [],
					targetPercent: target.value.targetPercent,
					windowDays: target.value.windowDays,
					totals: Option.getOrNull(Option.flatMapNullishOr(totals, (byRule) => byRule.get(ruleId))),
				})
			})

			return { observe } satisfies SloAlertSourceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(SloReadService.layer))
}
