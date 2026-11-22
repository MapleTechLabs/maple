import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgOnboardingState } from "@maple/db/tables"
import { OnboardingPersistenceError, type OrgId } from "@maple/domain/http"
import { Array as Arr, Clock, Context, Duration, Effect, Layer } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { ALERTING_SYSTEM_USER_ID, systemTenant } from "@maple/backend/services/auth/system-tenant"
import { OnboardingService } from "./OnboardingService"
import { SignalPresenceService } from "./SignalPresenceService"
import { firstDataSeen } from "./first-data"

/**
 * Orgs younger than this are probed until their first data lands. Older ones that never sent
 * data are abandoned signups; the setup audit still stamps them if they come back.
 */
export const FIRST_DATA_SWEEP_WINDOW = Duration.days(30)
/** Bounds one tick's warehouse reads; newest orgs first, so a fresh signup is never starved. */
export const FIRST_DATA_SWEEP_LIMIT = 100
const PROBE_CONCURRENCY = 4

export interface FirstDataSweepResult {
	readonly candidates: number
	readonly stamped: number
	readonly failures: number
}

const toPersistenceError = (error: unknown) =>
	new OnboardingPersistenceError({
		message: error instanceof Error ? error.message : `First data sweep error: ${String(error)}`,
	})

/**
 * Stamps `firstDataReceivedAt` (and so emits `first_data_received`) for recent orgs whose
 * telemetry has arrived. Before this the stamp was only written when someone opened the setup
 * audit, so most orgs with data were never stamped and the funnel event barely fired.
 */
export class FirstDataSweepService extends Context.Service<FirstDataSweepService>()(
	"@maple/backend/services/org/FirstDataSweepService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const onboarding = yield* OnboardingService
			const signals = yield* SignalPresenceService
			const dbExecute = makeDbExecute(database, "FirstDataSweepService", toPersistenceError)

			const probe = Effect.fn("FirstDataSweepService.probe")(function* (
				orgId: OrgId,
				createdAt: number,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const report = yield* signals.read(systemTenant(orgId, ALERTING_SYSTEM_USER_ID))
				const firstData = firstDataSeen(report)
				if (firstData === undefined) return false
				return yield* onboarding.recordFirstDataReceived(orgId, Effect.succeed(createdAt), firstData)
			})

			const runTick = Effect.fn("FirstDataSweepService.runTick")(function* () {
				const now = yield* Clock.currentTimeMillis
				const candidates = yield* dbExecute((db) =>
					db.run(
						PG.from(OrgOnboardingState)
							.select(($) => ({ orgId: $.orgId, createdAt: $.createdAt }))
							.where(($) => [
								$.firstDataReceivedAt.isNull(),
								$.createdAt.gt(now - Duration.toMillis(FIRST_DATA_SWEEP_WINDOW)),
							])
							.orderBy(["createdAt", "desc"])
							.limit(FIRST_DATA_SWEEP_LIMIT),
					),
				)
				// One org's failure must not stop the rest; the next tick probes it again.
				const outcomes = yield* Effect.forEach(
					candidates,
					(row) =>
						probe(row.orgId, row.createdAt).pipe(
							Effect.map((stamped) => (stamped ? "stamped" : "pending")),
							Effect.catch((error) =>
								Effect.logWarning("First data probe failed").pipe(
									Effect.annotateLogs({ orgId: row.orgId, error: error.message }),
									Effect.as("failed"),
								),
							),
						),
					{ concurrency: PROBE_CONCURRENCY },
				)
				const result: FirstDataSweepResult = {
					candidates: candidates.length,
					stamped: Arr.filter(outcomes, (outcome) => outcome === "stamped").length,
					failures: Arr.filter(outcomes, (outcome) => outcome === "failed").length,
				}
				yield* Effect.annotateCurrentSpan({
					"maple.first_data.candidates": result.candidates,
					"maple.first_data.stamped": result.stamped,
					"maple.first_data.failures": result.failures,
				})
				return result
			})

			return { runTick }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(OnboardingService.layer, SignalPresenceService.layer)),
	)
}
