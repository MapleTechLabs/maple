import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { OrgId, RoleName, UserId, VcsInstallationId, VcsRepositoryId } from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { VcsRepositories } from "@maple/db/tables"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { CI_MAX_SPAN_MS, CiAnalyticsService } from "./CiAnalyticsService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_ci_analytics")
const OTHER_ORG = Schema.decodeUnknownSync(OrgId)("org_other")
const REPO = Schema.decodeUnknownSync(VcsRepositoryId)("00000000-0000-4000-8000-000000000001")
const OTHER_REPO = Schema.decodeUnknownSync(VcsRepositoryId)("00000000-0000-4000-8000-000000000002")
const INSTALLATION = Schema.decodeUnknownSync(VcsInstallationId)("00000000-0000-4000-8000-0000000000aa")
const tenant: TenantContext = {
	orgId: ORG,
	userId: Schema.decodeUnknownSync(UserId)("user_ci"),
	roles: [Schema.decodeUnknownSync(RoleName)("org:admin")],
	authMode: "self_hosted",
}

const HOUR = 3_600_000
const END = Date.UTC(2026, 9, 8)
const wire = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ")
const traceId = (n: number) => n.toString(16).padStart(32, "0")

const run = (n: number, result: string, startedAt: number, extra: Record<string, unknown> = {}) => ({
	traceId: traceId(n),
	pipeline: "CI",
	runId: String(1000 + n),
	result,
	url: `https://github.com/acme/web/actions/runs/${1000 + n}`,
	repository: "web",
	branch: "main",
	revision: `sha${n}`,
	attempt: 1,
	trigger: "push",
	actor: "ada",
	pullRequest: 0,
	durationMs: 60_000,
	startedAt: wire(startedAt),
	...extra,
})

/** Rows each query context answers with, and the SQL of every query read. */
const harness = (rows: Record<string, ReadonlyArray<Record<string, unknown>>>) => {
	const reads: Array<{ context: string; sql: string }> = []
	const warehouse = makeWarehouseServiceStub({
		compiledQuery: (_tenant, compiled, options) => {
			const query = compiledQueryOf(compiled)
			const context = options?.context ?? ""
			reads.push({ context, sql: query.sql })
			return query.decodeRows(rows[context] ?? []).pipe(Effect.orDie)
		},
	})
	return { reads, warehouse }
}

const withService = <A, E>(
	rows: Record<string, ReadonlyArray<Record<string, unknown>>>,
	body: (
		service: CiAnalyticsService["Service"],
		reads: Array<{ context: string; sql: string }>,
	) => Effect.Effect<A, E, Database>,
) =>
	Effect.gen(function* () {
		const testDb = createTestDb(trackedDbs)
		const { reads, warehouse } = harness(rows)
		return yield* Effect.gen(function* () {
			const database = yield* Database
			yield* database.execute((db) =>
				db.run(
					PG.insertInto(VcsRepositories).values(
						[
							{ id: REPO, orgId: ORG, fullName: "acme/web" },
							{ id: OTHER_REPO, orgId: OTHER_ORG, fullName: "other/api" },
						].map((repo) => ({
							...repo,
							provider: "github" as const,
							installationId: INSTALLATION,
							externalRepoId: repo.id,
							owner: repo.fullName.split("/")[0] ?? "",
							name: repo.fullName.split("/")[1] ?? "",
							htmlUrl: `https://github.com/${repo.fullName}`,
							createdAt: END,
							updatedAt: END,
						})),
					),
				),
			)
			const service = yield* CiAnalyticsService
			return yield* body(service, reads)
		}).pipe(
			Effect.provide(
				Layer.effect(CiAnalyticsService, CiAnalyticsService.make).pipe(
					Layer.provideMerge(
						Layer.mergeAll(testDb.layer, Layer.succeed(WarehouseQueryService, warehouse)),
					),
				),
			),
		)
	})

describe("CiAnalyticsService.analytics", () => {
	it.effect("reads at most the newest two weeks and fills every bucket of it", () =>
		withService({}, (service) =>
			Effect.gen(function* () {
				const analytics = yield* service.analytics(tenant, {
					startTime: END - 30 * 24 * HOUR,
					endTime: END,
				})
				assert.strictEqual(analytics.startTime, END - CI_MAX_SPAN_MS)
				assert.strictEqual(analytics.bucketSeconds, 6 * 3600)
				assert.strictEqual(analytics.series.length, 14 * 4)
				assert.deepStrictEqual(analytics.series[0]?.p50DurationMs, null)
				assert.strictEqual(analytics.current.runs, 0)
				assert.strictEqual(analytics.current.p50QueueMs, null)
			}),
		),
	)

	it.effect("scopes every read to the repository's owner and name", () =>
		withService({}, (service, reads) =>
			Effect.gen(function* () {
				yield* service.analytics(tenant, {
					startTime: END - 24 * HOUR,
					endTime: END,
					repositoryId: REPO,
				})
				assert.isAbove(reads.length, 0)
				for (const read of reads) {
					assert.include(read.sql, ".Owner = 'acme'")
					assert.include(read.sql, ".Repository = 'web'")
				}
			}),
		),
	)

	it.effect("answers another org's repository with nothing, without reading the warehouse", () =>
		withService({}, (service, reads) =>
			Effect.gen(function* () {
				const analytics = yield* service.analytics(tenant, {
					startTime: END - 24 * HOUR,
					endTime: END,
					repositoryId: OTHER_REPO,
				})
				assert.strictEqual(reads.length, 0)
				assert.strictEqual(analytics.pipelines.length, 0)
				assert.strictEqual(analytics.series.length, 24)
			}),
		),
	)

	it.effect("names a red workflow's first failed run and last green commit", () =>
		withService(
			{
				ciPipelineStats: [
					{
						owner: "acme",
						repository: "web",
						pipeline: "CI",
						runs: "4",
						succeeded: "1",
						failed: "2",
						cancelled: "1",
						p50DurationMs: 60_000,
						p95DurationMs: 90_000,
						totalDurationMs: 240_000,
						lastResult: "failure",
						lastStartedAt: wire(END - HOUR),
					},
				],
				// Newest first: a cancelled run inside the streak neither extends nor ends it.
				ciWorkflowRuns: [
					run(4, "failure", END - HOUR),
					run(3, "cancellation", END - 2 * HOUR),
					run(2, "timeout", END - 3 * HOUR),
					run(1, "success", END - 4 * HOUR),
				],
				ciRunSeries: [
					{
						bucket: wire(END - 3 * HOUR),
						runs: "1",
						succeeded: "0",
						failed: "1",
						cancelled: "0",
						p50DurationMs: 60_000,
						p95DurationMs: 60_000,
						totalDurationMs: 60_000,
					},
				],
			},
			(service, reads) =>
				Effect.gen(function* () {
					const analytics = yield* service.analytics(tenant, {
						startTime: END - 24 * HOUR,
						endTime: END,
					})
					// The red workflow's own runs are read, skipped ones left out.
					const runsRead = reads.find((read) => read.context === "ciWorkflowRuns")
					assert.include(runsRead?.sql ?? "", "ci_runs.Pipeline = 'CI'")
					assert.include(runsRead?.sql ?? "", "ci_runs.Owner = 'acme'")
					assert.include(runsRead?.sql ?? "", "!= 'skip'")
					const red = analytics.pipelines[0]?.red
					assert.strictEqual(red?.failedRuns, 2)
					assert.strictEqual(red?.firstFailedRevision, "sha2")
					assert.strictEqual(red?.firstFailedTraceId, traceId(2))
					assert.strictEqual(red?.lastGreenRevision, "sha1")
					assert.strictEqual(red?.lastGreenAt, END - 4 * HOUR)
					const bucket = analytics.series.find((slot) => slot.bucket === END - 3 * HOUR)
					assert.strictEqual(bucket?.failed, 1)
					assert.strictEqual(bucket?.p50DurationMs, 60_000)
				}),
		),
	)
})

describe("CiAnalyticsService.analytics streaks", () => {
	it.effect("reads no runs for a workflow whose latest run passed", () =>
		withService(
			{
				ciPipelineStats: [
					{
						owner: "acme",
						repository: "web",
						pipeline: "CI",
						runs: "1",
						succeeded: "1",
						failed: "0",
						cancelled: "0",
						p50DurationMs: 60_000,
						p95DurationMs: 60_000,
						totalDurationMs: 60_000,
						lastResult: "success",
						lastStartedAt: wire(END - HOUR),
					},
				],
			},
			(service, reads) =>
				Effect.gen(function* () {
					const analytics = yield* service.analytics(tenant, {
						startTime: END - 24 * HOUR,
						endTime: END,
					})
					assert.strictEqual(analytics.pipelines[0]?.red, null)
					assert.isUndefined(reads.find((read) => read.context === "ciWorkflowRuns"))
				}),
		),
	)
})

describe("CiAnalyticsService.analytics streak checks", () => {
	it.effect("checks at most ten possibly red workflows", () =>
		withService(
			{
				ciPipelineStats: Array.from({ length: 12 }, (_, i) => ({
					owner: "acme",
					repository: "web",
					pipeline: `Workflow ${i}`,
					runs: String(100 - i),
					succeeded: "0",
					failed: "1",
					cancelled: "0",
					p50DurationMs: 60_000,
					p95DurationMs: 60_000,
					totalDurationMs: 60_000,
					lastResult: "failure",
					lastStartedAt: wire(END - HOUR),
				})),
			},
			(service, reads) =>
				Effect.gen(function* () {
					const analytics = yield* service.analytics(tenant, {
						startTime: END - 24 * HOUR,
						endTime: END,
					})
					assert.strictEqual(analytics.pipelines.length, 12)
					assert.strictEqual(reads.filter((read) => read.context === "ciWorkflowRuns").length, 10)
				}),
		),
	)
})

describe("CiAnalyticsService.listRuns", () => {
	it.effect("pages by cursor and attaches each failed run's failed jobs", () =>
		withService(
			{
				ciRuns: [
					run(3, "failure", END - HOUR, { pullRequest: 42, attempt: 2 }),
					run(2, "success", END - 2 * HOUR),
					run(1, "success", END - 3 * HOUR),
				],
				ciFailedJobs: [
					{
						traceId: traceId(3),
						job: "Tests",
						result: "failure",
						reason: "expected 1 to be 2",
						url: "https://github.com/acme/web/actions/runs/1003/job/1",
						durationMs: 30_000,
					},
				],
			},
			(service, reads) =>
				Effect.gen(function* () {
					const page = yield* service.listRuns(tenant, {
						startTime: END - 24 * HOUR,
						endTime: END,
						limit: 2,
					})
					assert.deepStrictEqual(
						page.runs.map((r) => r.traceId),
						[traceId(3), traceId(2)],
					)
					assert.strictEqual(page.nextCursor, `${END - 2 * HOUR}_${traceId(2)}`)
					const failed = page.runs[0]
					assert.strictEqual(failed?.pullRequest, 42)
					assert.strictEqual(failed?.attempt, 2)
					assert.deepStrictEqual(
						failed?.failedJobs.map((job) => job.reason),
						["expected 1 to be 2"],
					)
					assert.strictEqual(page.runs[1]?.pullRequest, null)
					// Only the failed run's jobs are read.
					const jobsRead = reads.find((read) => read.context === "ciFailedJobs")
					assert.include(jobsRead?.sql ?? "", traceId(3))
					assert.notInclude(jobsRead?.sql ?? "", traceId(2))

					// A failed run's jobs are read up to the end of the run, not the window.
					assert.include(jobsRead?.sql ?? "", `ci_jobs.Timestamp <= '${wire(END - HOUR + 61_000)}'`)

					yield* service.listRuns(tenant, {
						startTime: END - 24 * HOUR,
						endTime: END,
						limit: 2,
						cursor: page.nextCursor ?? undefined,
					})
					const lastRead = reads.filter((read) => read.context === "ciRuns").at(-1)
					assert.include(lastRead?.sql ?? "", `ci_runs.TraceId < '${traceId(2)}'`)
				}),
		),
	)

	it.effect("ends the list when a page comes back short", () =>
		withService({ ciRuns: [run(1, "success", END - HOUR)] }, (service) =>
			Effect.gen(function* () {
				const page = yield* service.listRuns(tenant, { startTime: END - 24 * HOUR, endTime: END })
				assert.strictEqual(page.runs.length, 1)
				assert.strictEqual(page.nextCursor, null)
			}),
		),
	)
})
