import { orgIngestKeys, orgOnboardingState } from "@maple/db"
import type { OrgId } from "@maple/domain/http"
import * as CH from "@maple/query-engine/ch"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { eq, isNull } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Layer, Option } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { systemTenant } from "@maple/backend/services/alerts/system-tenant"
import { OnboardingService } from "@maple/backend/services/org/OnboardingService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

/** The tick runs hourly; two hours of hourly aggregates tolerate one missed fire. */
const DISCOVERY_WINDOW_MS = 2 * 60 * 60 * 1000

const ORG_CONCURRENCY = 4

/**
 * Stamps `org_onboarding_state.first_data_received_at` once an org's telemetry reaches the
 * warehouse. The setup audit gates on it, and maple-portal's onboarding campaign reads it
 * (`packages/db/src/external-columns.test.ts`).
 *
 * One cross-org scan of the hourly aggregates finds which unstamped orgs are sending. BYO-ClickHouse
 * orgs are invisible to that scan and stay unstamped; the setup audit reads their warehouse itself.
 */
export class FirstDataService extends Context.Service<FirstDataService>()(
	"@maple/api/services/FirstDataService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const warehouse = yield* WarehouseQueryService
			const onboarding = yield* OnboardingService
			const organizations = yield* OrganizationService

			const findUnstampedOrgs = () =>
				database
					.execute((db) =>
						db
							.selectDistinct({ orgId: orgIngestKeys.orgId })
							.from(orgIngestKeys)
							.leftJoin(orgOnboardingState, eq(orgOnboardingState.orgId, orgIngestKeys.orgId))
							.where(isNull(orgOnboardingState.firstDataReceivedAt)),
					)
					.pipe(Effect.map((rows) => rows.map((row) => row.orgId)))

			const findActiveOrgs = Effect.fn("FirstDataService.findActiveOrgs")(function* (
				routingOrg: OrgId,
			) {
				const now = yield* Clock.currentTimeMillis
				const startTime = formatWarehouseDateTime(now - DISCOVERY_WINDOW_MS)
				const justification =
					"find orgs sending their first telemetry to stamp first_data_received_at"
				const [traces, logs] = yield* Effect.all(
					[
						warehouse.crossOrgQuery(
							systemTenant(routingOrg),
							CH.compile(CH.activeOrgsByTracesQuery(), { startTime }),
							{ profile: "discovery", context: "firstDataActiveOrgsTraces", justification },
						),
						warehouse.crossOrgQuery(
							systemTenant(routingOrg),
							CH.compile(CH.activeOrgsByLogsQuery(), { startTime }),
							{ profile: "discovery", context: "firstDataActiveOrgsLogs", justification },
						),
					],
					{ concurrency: 2 },
				)
				return new Set<string>([...traces, ...logs].map((row) => row.orgId))
			})

			/**
			 * The row's `created_at` is the org's creation time from the identity provider, as the
			 * checklist writes it; without one (self-hosted) no row is created, matching the checklist.
			 */
			const stampOrg = Effect.fn("FirstDataService.stampOrg")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				if (Option.isNone(yield* onboarding.findState(orgId))) {
					const org = yield* organizations.retrieve(orgId)
					if (org.createdAtMs === null) return false
					yield* onboarding.ensureRow(orgId, undefined, undefined, { createdAt: org.createdAtMs })
				}
				return yield* onboarding.recordFirstDataReceived(orgId)
			})

			const runTick = Effect.fn("FirstDataService.runTick")(function* () {
				const unstamped = yield* findUnstampedOrgs()
				const [routingOrg] = unstamped
				if (routingOrg === undefined) return { unstampedOrgs: 0, stamped: 0, orgFailures: 0 }

				const active = yield* findActiveOrgs(routingOrg)
				const results = yield* Effect.forEach(
					unstamped.filter((orgId) => active.has(orgId)),
					(orgId) =>
						stampOrg(orgId).pipe(
							Effect.map((stamped) => ({ stamped, failed: false })),
							Effect.catchCause((cause) =>
								Cause.hasInterruptsOnly(cause)
									? Effect.interrupt
									: Effect.logWarning("First-data stamp failed for org").pipe(
											Effect.annotateLogs({ orgId, error: summarizeCause(cause) }),
											Effect.as({ stamped: false, failed: true }),
										),
							),
						),
					{ concurrency: ORG_CONCURRENCY },
				)
				return {
					unstampedOrgs: unstamped.length,
					stamped: results.filter((result) => result.stamped).length,
					orgFailures: results.filter((result) => result.failed).length,
				}
			})

			return { runTick }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(WarehouseQueryService.layer, OnboardingService.layer, OrganizationService.layer),
		),
	)
}
