import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertRules, Slos } from "@maple/db/tables"
import { AlertThresholds, SloPersistenceError, type WarehouseReadError } from "@maple/domain/http"
import type { AlertRuleId, OrgId } from "@maple/primitives"
import type { SloBurnWindow, SloCounts } from "@maple/domain/slo"
import { Array as Arr, Cache, Context, Data, Duration, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { makeSloPersistenceError } from "./slo-persistence"
import { ALERTING_SYSTEM_USER_ID, systemTenant } from "@maple/backend/services/auth/system-tenant"
import { SloReadService } from "./SloReadService"
import type { SloBatchTarget } from "./slo-reads"
import { sloRuleThresholds } from "./slo-alert-rule"

/**
 * The SLO window's events as one check sees them. The budget moves slowly and its read spans the
 * whole window, so it is read on every fifth tick; in between, and when the read fails, a check
 * judges no budget.
 */
export type SloBudgetRead =
	| { readonly _tag: "read"; readonly totals: SloCounts }
	| { readonly _tag: "notDue" }
	| { readonly _tag: "unread" }

/** What one check of an SLO's burn-rate rule reads. */
export interface SloObservation {
	readonly windows: ReadonlyArray<SloBurnWindow>
	readonly targetPercent: number
	readonly windowDays: number
	readonly budget: SloBudgetRead
}

export interface SloAlertSourceApi {
	/** What the SLO that owns `ruleId` reads at `endMs`; `None` when no SLO owns it. */
	readonly observe: (
		orgId: OrgId,
		ruleId: AlertRuleId,
		endMs: number,
	) => Effect.Effect<Option.Option<SloObservation>, SloPersistenceError | WarehouseReadError>
	/**
	 * Rewrites the stored thresholds and window of an SLO's rule from its target. They are only
	 * what an incident displays, so a rule saved before the tiers changed is brought up to date here.
	 */
	readonly resyncRule: (
		orgId: OrgId,
		ruleId: AlertRuleId,
		targetPercent: number,
	) => Effect.Effect<void, SloPersistenceError>
}

/** One tick of one org: every SLO rule checked in it shares a read. */
class TickKey extends Data.Class<{ readonly orgId: OrgId; readonly endMs: number }> {}

const decodeThresholds = Schema.decodeUnknownOption(AlertThresholds)

const MINUTE_MS = 60_000
/** The budget is read when the tick's minute is a multiple of this. */
export const SLO_BUDGET_READ_EVERY_MINUTES = 5

const isBudgetTick = (endMs: number): boolean =>
	Math.floor(endMs / MINUTE_MS) % SLO_BUDGET_READ_EVERY_MINUTES === 0

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
			// many SLOs it has; each rule's check then looks its own windows up. The worker builds
			// its services per tick, so nothing here outlives one.
			const readsByTick = yield* Cache.make({
				capacity: 64,
				timeToLive: Duration.minutes(2),
				lookup: (key: TickKey) =>
					Effect.gen(function* () {
						const targets = yield* targetsOf(key.orgId)
						const tenant = systemTenant(key.orgId, ALERTING_SYSTEM_USER_ID)
						const windows = yield* reads.burnBatch(tenant, targets, key.endMs)
						if (!isBudgetTick(key.endMs)) return { targets, windows, totals: "notDue" as const }
						// Best effort: without the totals a check still judges the burn.
						const totals = yield* reads.totalsBatch(tenant, targets, key.endMs).pipe(
							Effect.tapError((error) =>
								Effect.logWarning("SLO window totals could not be read for alerting").pipe(
									Effect.annotateLogs({ orgId: key.orgId, "error.type": error._tag }),
								),
							),
							Effect.orElseSucceed(() => "unread" as const),
						)
						return { targets, windows, totals }
					}),
			})

			const observe = Effect.fn("SloAlertSource.observe")(function* (
				orgId: OrgId,
				ruleId: AlertRuleId,
				endMs: number,
			) {
				const tick = yield* Cache.get(readsByTick, new TickKey({ orgId, endMs }))
				const target = Arr.findFirst(tick.targets, (slo) => slo.id === ruleId)
				if (Option.isNone(target)) return Option.none<SloObservation>()
				const budget: SloBudgetRead =
					tick.totals === "notDue" || tick.totals === "unread"
						? { _tag: tick.totals }
						: Option.match(Option.fromNullishOr(tick.totals.get(ruleId)), {
								onNone: () => ({ _tag: "unread" }),
								onSome: (totals) => ({ _tag: "read", totals }),
							})
				return Option.some<SloObservation>({
					windows: tick.windows.get(ruleId) ?? [],
					targetPercent: target.value.targetPercent,
					windowDays: target.value.windowDays,
					budget,
				})
			})

			const resyncRule = Effect.fn("SloAlertSource.resyncRule")(function* (
				orgId: OrgId,
				ruleId: AlertRuleId,
				targetPercent: number,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.rule_id": ruleId })
				const expected = sloRuleThresholds(targetPercent)
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const rows = yield* db.run(
								PG.from(AlertRules)
									.select("thresholdsJson")
									.where(($) => [
										$.orgId.eq(orgId),
										$.id.eq(ruleId),
										$.signalType.eq("slo_burn_rate"),
									])
									.forUpdate(),
							)
							const stored = Option.getOrNull(decodeThresholds(rows[0]?.thresholdsJson))
							if (stored === null) return
							// `updatedAt` stays: this changes what is displayed, not what the rule is.
							yield* db.run(
								PG.update(AlertRules)
									.set({
										thresholdsJson: Arr.map(stored, (tier) => ({
											...tier,
											value: expected.valueOf(tier.severity),
										})),
										threshold: expected.threshold,
										windowMinutes: expected.windowMinutes,
									})
									.where(($) => [$.orgId.eq(orgId), $.id.eq(ruleId)]),
							)
						}),
					),
				)
			})

			return { observe, resyncRule } satisfies SloAlertSourceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(SloReadService.layer))
}
