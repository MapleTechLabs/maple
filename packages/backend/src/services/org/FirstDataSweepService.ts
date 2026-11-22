import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgIngestKeys, OrgOnboardingState } from "@maple/db/tables"
import { OnboardingPersistenceError, type OrgId } from "@maple/domain/http"
import { Array as Arr, Clock, Context, Duration, Effect, Layer } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { ALERTING_SYSTEM_USER_ID, systemTenant } from "@maple/backend/services/auth/system-tenant"
import { OnboardingService } from "./OnboardingService"
import { OrganizationService } from "./OrganizationService"
import { readOrgCreatedAt } from "./org-created-at"
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

interface Candidate {
	readonly orgId: OrgId
	/** The onboarding row's creation time; `null` when the org has no row yet. */
	readonly createdAt: number | null
	readonly userId: string | null
}

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
			const organizations = yield* OrganizationService
			const dbExecute = makeDbExecute(database, "FirstDataSweepService", toPersistenceError)

			const probe = Effect.fn("FirstDataSweepService.probe")(function* (candidate: Candidate) {
				yield* Effect.annotateCurrentSpan({ orgId: candidate.orgId })
				const report = yield* signals.read(systemTenant(candidate.orgId, ALERTING_SYSTEM_USER_ID))
				const firstData = firstDataSeen(report)
				if (firstData === undefined) return false
				// An org with no onboarding row yet gets one dated by its real creation time.
				const orgCreatedAt =
					candidate.createdAt === null
						? readOrgCreatedAt(organizations, candidate.orgId)
						: Effect.succeed(candidate.createdAt)
				return yield* onboarding.recordFirstDataReceived(
					candidate.orgId,
					orgCreatedAt,
					firstData,
					candidate.userId,
				)
			})

			/**
			 * Unstamped onboarding rows, plus orgs whose ingest key is recent but that have no stamp:
			 * Quick Start can send data before anything writes the onboarding row. Telemetry needs the
			 * key, so an org stamped since the window opened is the only one to leave out.
			 */
			const findCandidates = Effect.fn("FirstDataSweepService.findCandidates")(function* (
				cutoff: number,
			) {
				const [unstamped, stampedRecently, recentKeys] = yield* Effect.all(
					[
						dbExecute((db) =>
							db.run(
								PG.from(OrgOnboardingState)
									.select(($) => ({
										orgId: $.orgId,
										createdAt: $.createdAt,
										userId: $.userId,
									}))
									.where(($) => [$.firstDataReceivedAt.isNull(), $.createdAt.gt(cutoff)])
									.orderBy(($) => [[$.createdAt, "desc"]])
									.limit(FIRST_DATA_SWEEP_LIMIT),
							),
						),
						dbExecute((db) =>
							db.run(
								PG.from(OrgOnboardingState)
									.select(($) => ({ orgId: $.orgId }))
									.where(($) => [$.firstDataReceivedAt.gt(cutoff)]),
							),
						),
						dbExecute((db) =>
							db.run(
								PG.from(OrgIngestKeys)
									.select(($) => ({ orgId: $.orgId, createdBy: $.createdBy }))
									.where(($) => [$.createdAt.gt(cutoff)])
									.orderBy(($) => [[$.createdAt, "desc"]])
									.limit(FIRST_DATA_SWEEP_LIMIT),
							),
						),
					],
					{ concurrency: "unbounded" },
				)
				const known = new Set<string>([
					...Arr.map(unstamped, (row) => row.orgId),
					...Arr.map(stampedRecently, (row) => row.orgId),
				])
				const fromRows: ReadonlyArray<Candidate> = Arr.map(unstamped, (row) => ({
					orgId: row.orgId,
					createdAt: row.createdAt,
					userId: row.userId,
				}))
				const fromKeys: ReadonlyArray<Candidate> = Arr.map(
					Arr.filter(recentKeys, (row) => !known.has(row.orgId)),
					(row) => ({ orgId: row.orgId, createdAt: null, userId: row.createdBy }),
				)
				return Arr.take([...fromRows, ...fromKeys], FIRST_DATA_SWEEP_LIMIT)
			})

			const runTick = Effect.fn("FirstDataSweepService.runTick")(function* () {
				const now = yield* Clock.currentTimeMillis
				const candidates = yield* findCandidates(now - Duration.toMillis(FIRST_DATA_SWEEP_WINDOW))
				// One org's failure must not stop the rest; the next tick probes it again.
				const outcomes = yield* Effect.forEach(
					candidates,
					(row) =>
						probe(row).pipe(
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
		Layer.provide(
			Layer.mergeAll(OnboardingService.layer, SignalPresenceService.layer, OrganizationService.layer),
		),
	)
}
