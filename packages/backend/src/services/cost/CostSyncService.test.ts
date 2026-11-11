import { afterEach, assert, describe, it } from "@effect/vitest"
import { DateTime, Duration, Effect, Fiber, Layer, Option, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { WarehouseUpstreamError } from "@maple/domain/http"
import { DISABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	insertTestSource,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { type CostProviderAdapter, CostProviderError, type CostPullRow } from "./CostProvider"
import { CostSyncService } from "./CostSyncService"
import { AwsCostProvider } from "./providers/aws/AwsCostProvider"
import { BACKFILL_REQUEST_BUDGET, daysOfWindow, MONTHLY_REQUEST_BUDGET } from "./sync-plan"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-11T12:00:00Z"))
const HOUR_MS = 60 * 60_000
const CONNECTION_A = "0190f2b3-0000-7000-8000-0000000000a1"
const CONNECTION_B = "0190f2b3-0000-7000-8000-0000000000b1"
/** What every fake pull reports as billable. */
const REQUESTS_PER_PULL = 2

/** A `cost_daily` row as the sync hands it to `ingest`. */
const WrittenRow = Schema.Struct({
	OrgId: Schema.String,
	SourceId: Schema.String,
	Provider: Schema.String,
	AccountId: Schema.String,
	Date: Schema.String,
	CloudService: Schema.String,
	ChargeCategory: Schema.String,
	Currency: Schema.String,
	BilledCost: Schema.Number,
	EffectiveCost: Schema.Number,
	Estimated: Schema.Number,
	IngestedAt: Schema.String,
})
const decodeWrittenRows = Schema.decodeUnknownSync(Schema.Array(WrittenRow))

type Reason = CostProviderError["reason"]

interface FakeProviderOptions {
	/** Every pull fails with this reason, after `failRequests` billable requests. */
	readonly failReason?: Reason
	readonly failRequests?: number
	/** Pulls of a window starting on one of these days fail as `upstream`; the rest succeed. */
	readonly failWindowsFrom?: ReadonlyArray<string>
	/** Days the provider answers no rows for. */
	readonly emptyDays?: ReadonlyArray<string>
	/** Days the provider answers a row for in every pull, whatever window was asked. */
	readonly strayDays?: ReadonlyArray<string>
	/** Another tick takes the row over while the pull is in flight. */
	readonly stealLease?: boolean
	/** A second passes during each pull, so every step reads its own clock. */
	readonly pullTakesASecond?: boolean
	/** Every `ingest` call answers 503. */
	readonly failIngest?: boolean
}

const pullRow = (day: string): CostPullRow => ({
	day,
	accountId: "123456789012",
	cloudService: "Amazon Simple Storage Service",
	serviceCategory: "Storage",
	usageType: "TimedStorage-ByteHrs",
	region: "us-east-1",
	resourceId: "",
	resourceType: "",
	serviceName: "",
	chargeCategory: "usage",
	basis: "billed",
	currency: "USD",
	billedCost: 3,
	effectiveCost: 3,
	listCost: 3,
	consumedQuantity: 10,
	consumedUnit: "GB-Mo",
	tags: {},
	estimated: day >= "2026-11-01",
})

interface SourceState {
	readonly watermark: string | null
	readonly backfill: string | null
	readonly synced: string | null
	readonly settled: string | null
	readonly lease: string | null
	readonly next: string | null
	readonly failures: number
	readonly error: string | null
	readonly reason: string | null
	readonly month: string | null
	readonly requests: number
}

const ms = (column: string) => `(extract(epoch from ${column}) * 1000)::bigint::text`

const harness = (options: FakeProviderOptions = {}) => {
	const testDb = createTestDb(trackedDbs)
	const sql = (statement: string, params: unknown[] = []) =>
		Effect.promise(() => executeSql(testDb, statement, params))
	const pulls: Array<{
		readonly orgId: string
		readonly connectionRef: string
		readonly startDay: string
		readonly endDay: string
	}> = []
	const adapter: CostProviderAdapter = {
		provider: "aws",
		pull: (source, window) =>
			Effect.gen(function* () {
				pulls.push({ orgId: source.orgId, connectionRef: source.connectionRef, ...window })
				if (options.pullTakesASecond === true) yield* TestClock.adjust("1 second")
				if (options.stealLease === true) {
					yield* sql("UPDATE cost_sources SET lease_until = to_timestamp($1 / 1000.0)", [
						NOW + 14 * 60_000,
					])
				}
				const failReason =
					options.failReason ??
					(options.failWindowsFrom?.includes(window.startDay) === true ? "upstream" : undefined)
				if (failReason !== undefined) {
					return yield* new CostProviderError({
						message: `The provider answered ${failReason}`,
						provider: "aws",
						reason: failReason,
						requests: options.failRequests ?? 1,
					})
				}
				return {
					rows: Arr.map(
						[
							...Arr.filter(
								daysOfWindow(window),
								(day) => options.emptyDays?.includes(day) !== true,
							),
							...(options.strayDays ?? []),
						],
						pullRow,
					),
					requests: REQUESTS_PER_PULL,
				}
			}),
	}
	const writes: Array<ReadonlyArray<typeof WrittenRow.Type>> = []
	const datasources: string[] = []
	const tenants: string[] = []
	const warehouse = Layer.succeed(
		WarehouseQueryService,
		makeWarehouseServiceStub({
			ingest: (tenant, datasource, rows) =>
				Effect.suspend(() => {
					if (options.failIngest === true) {
						return Effect.fail(
							new WarehouseUpstreamError({
								message: "503",
								pipeName: "ingest",
								upstreamStatus: 503,
							}),
						)
					}
					tenants.push(tenant.orgId)
					datasources.push(datasource)
					writes.push(decodeWrittenRows(rows))
					return Effect.void
				}),
		}),
	)
	// Every org is in the `cloudCost` rollout until a test takes it out.
	const outsideRollout = new Set<string>()
	const setCloudCost = (orgId: string, enabled: boolean) =>
		Effect.sync(() => {
			if (enabled) outsideRollout.delete(orgId)
			else outsideRollout.add(orgId)
		})
	const featureFlags = Layer.succeed(OrganizationFeatureFlagsService, {
		flags: (orgId) =>
			Effect.sync(() => ({
				...DISABLED_ORGANIZATION_FEATURE_FLAGS,
				cloudCost: !outsideRollout.has(orgId),
			})),
	})
	const layer = Layer.effect(CostSyncService, CostSyncService.make).pipe(
		Layer.provide(Layer.mergeAll(Layer.succeed(AwsCostProvider, adapter), warehouse, featureFlags)),
		Layer.provide(testDb.layer),
	)
	/** An AWS connection asking for cost; `granted` null is a role no check has read yet. */
	const connect = (connection: {
		readonly id: string
		readonly orgId?: string
		readonly account?: string
		readonly modules?: ReadonlyArray<string>
		readonly granted?: ReadonlyArray<string> | null
		readonly verified?: boolean
	}) =>
		Effect.promise(async () => {
			const orgId = connection.orgId ?? "org_a"
			const sourceId = await insertTestSource(testDb, { orgId, platform: "aws", name: connection.id })
			const granted = connection.granted === undefined ? ["inventory", "cost"] : connection.granted
			await executeSql(
				testDb,
				`INSERT INTO aws_connections
				   (id, org_id, source_id, account_id, modules, granted_modules, verified_at, created_by, created_at, updated_at)
				 VALUES ($1, $2, $3, $4, $6::jsonb, $5::jsonb, ${connection.verified === false ? "NULL" : "now()"}, 'user_a', now(), now())`,
				[
					connection.id,
					orgId,
					sourceId,
					connection.account ?? "123456789012",
					granted === null ? null : JSON.stringify(granted),
					JSON.stringify(connection.modules ?? ["inventory", "cost"]),
				],
			)
		})
	const sourceRefs = Effect.promise(() =>
		testDb.pglite.query<{ org: string; ref: string; account: string }>(
			"SELECT org_id AS org, connection_ref AS ref, account_id AS account FROM cost_sources ORDER BY org_id, connection_ref",
		),
	).pipe(Effect.map((result) => Arr.map(result.rows, (row) => [row.org, row.ref, row.account])))
	const sourceStateOf = (orgId: string, connectionRef: string) =>
		Effect.promise(() =>
			queryFirstRow<SourceState>(
				testDb,
				`SELECT watermark_date AS watermark, backfill_date AS backfill,
				        ${ms("last_synced_at")} AS synced, ${ms("last_settled_at")} AS settled,
				        ${ms("lease_until")} AS lease, ${ms("next_attempt_at")} AS next,
				        consecutive_failures AS failures, last_error AS error, last_error_reason AS reason,
				        requests_month AS month, requests_count AS requests
				   FROM cost_sources WHERE org_id = $1 AND connection_ref = $2`,
				[orgId, connectionRef],
			),
		)
	const sourceState = sourceStateOf("org_a", CONNECTION_A)
	/** The id and switch of `org_a`'s source: what must survive a pause. */
	const sourceIdentity = Effect.promise(() =>
		queryFirstRow<{ id: string; enabled: boolean }>(
			testDb,
			"SELECT id, enabled FROM cost_sources WHERE org_id = $1 AND connection_ref = $2",
			["org_a", CONNECTION_A],
		),
	)
	const writtenRows = () => Arr.flatten(writes)
	const windows = () => Arr.map(pulls, (pull) => [pull.startDay, pull.endDay])
	return {
		layer,
		pulls,
		windows,
		writes,
		writtenRows,
		datasources,
		tenants,
		sql,
		connect,
		sourceRefs,
		sourceState,
		sourceStateOf,
		sourceIdentity,
		setCloudCost,
	}
}

const poll = CostSyncService.use((service) => service.pollAllSources)

/** `org_a`'s connection, granting cost, at NOW. */
const connectA = (h: ReturnType<typeof harness>) =>
	Effect.andThen(TestClock.setTime(NOW), h.connect({ id: CONNECTION_A }))

/** A source that pulled its open months an hour ago and has history left to walk. */
const seedSynced = (h: ReturnType<typeof harness>, at: number) =>
	h.sql(
		`UPDATE cost_sources SET watermark_date = '2026-11-11', backfill_date = '2026-10-01',
		        last_synced_at = to_timestamp($1 / 1000.0), last_settled_at = to_timestamp($1 / 1000.0)`,
		[at],
	)

/** Advance the test clock in small steps until the forked run settles, waiting on real I/O in between. */
const settleWithClock = <A, E>(fiber: Fiber.Fiber<A, E>) =>
	Effect.gen(function* () {
		yield* Effect.repeat(
			Effect.gen(function* () {
				yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
				if (fiber.pollUnsafe() !== undefined) return true
				yield* TestClock.adjust(Duration.millis(250))
				return false
			}),
			{ until: (done) => done, times: 2_000 },
		)
		return yield* Fiber.join(fiber)
	})

describe("CostSyncService sources", () => {
	it.effect("makes a source only for a verified connection that asks for cost and is granted it", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			yield* h.connect({ id: CONNECTION_A, account: "111111111111" })
			yield* h.connect({
				id: "0190f2b3-0000-7000-8000-0000000000a2",
				account: "222222222222",
				granted: ["inventory", "security"],
			})
			yield* h.connect({
				id: "0190f2b3-0000-7000-8000-0000000000a3",
				account: "333333333333",
				granted: null,
			})
			yield* h.connect({
				id: "0190f2b3-0000-7000-8000-0000000000a4",
				account: "444444444444",
				verified: false,
			})
			// The role still grants cost, but the org no longer asks for it.
			yield* h.connect({
				id: "0190f2b3-0000-7000-8000-0000000000a5",
				account: "555555555555",
				modules: ["inventory"],
			})
			const summary = yield* poll
			assert.deepStrictEqual(yield* h.sourceRefs, [["org_a", CONNECTION_A, "111111111111"]])
			assert.deepStrictEqual([summary.due, summary.synced], [1, 1])
			// A second tick finds the source it made, and makes no other.
			yield* poll
			assert.lengthOf(yield* h.sourceRefs, 1)
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("pauses a source whose grant is lost for a tick, and resumes the same source after", () => {
		const h = harness()
		const setGrant = (granted: string) =>
			h.sql("UPDATE aws_connections SET granted_modules = $2::jsonb WHERE id = $1", [
				CONNECTION_A,
				granted,
			])
		return Effect.gen(function* () {
			yield* connectA(h)
			yield* poll
			const identity = yield* h.sourceIdentity
			const state = yield* h.sourceState
			assert.strictEqual(identity?.enabled, true)

			yield* setGrant('["inventory"]')
			yield* TestClock.adjust("1 hour")
			const pullsBefore = h.pulls.length
			const paused = yield* poll
			assert.deepStrictEqual([paused.due, h.pulls.length], [0, pullsBefore])
			assert.deepStrictEqual(yield* h.sourceIdentity, { id: identity?.id, enabled: false })
			assert.deepStrictEqual(yield* h.sourceState, state)

			// The grant is back: the same source walks on from its frontier, not from the start.
			yield* setGrant('["inventory", "cost"]')
			yield* TestClock.adjust("1 hour")
			const resumed = yield* poll
			assert.strictEqual(resumed.synced, 1)
			assert.deepStrictEqual(h.windows().slice(pullsBefore), [
				["2026-07-01", "2026-07-31"],
				["2026-06-01", "2026-06-30"],
				["2026-05-01", "2026-05-31"],
			])
			assert.deepStrictEqual(yield* h.sourceIdentity, { id: identity?.id, enabled: true })
			assert.strictEqual(new Set(Arr.map(h.writtenRows(), (row) => row.SourceId)).size, 1)
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("pauses a source when the org stops asking for cost, though the role still grants it", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectA(h)
			yield* poll
			const identity = yield* h.sourceIdentity
			yield* h.sql(`UPDATE aws_connections SET modules = '["inventory"]'::jsonb WHERE id = $1`, [
				CONNECTION_A,
			])
			yield* TestClock.adjust("1 hour")
			const pullsBefore = h.pulls.length
			const summary = yield* poll
			assert.deepStrictEqual([summary.due, h.pulls.length], [0, pullsBefore])
			assert.deepStrictEqual(yield* h.sourceIdentity, { id: identity?.id, enabled: false })
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("removes a source only when its connection is gone", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectA(h)
			yield* h.connect({ id: CONNECTION_B, account: "222222222222" })
			yield* poll
			assert.lengthOf(yield* h.sourceRefs, 2)
			// One loses its grant and stays; the other loses its connection and goes.
			yield* h.sql(`UPDATE aws_connections SET granted_modules = NULL WHERE id = $1`, [CONNECTION_A])
			yield* h.sql("DELETE FROM aws_connections WHERE id = $1", [CONNECTION_B])
			yield* TestClock.adjust("1 hour")
			const pullsBefore = h.pulls.length
			const summary = yield* poll
			assert.deepStrictEqual(yield* h.sourceRefs, [["org_a", CONNECTION_A, "123456789012"]])
			assert.strictEqual((yield* h.sourceIdentity)?.enabled, false)
			assert.deepStrictEqual([summary.due, h.pulls.length], [0, pullsBefore])
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("never pulls one org's connection for another org's source", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectA(h)
			// A source of org_b that names org_a's connection: a ref never crosses orgs.
			yield* h.sql(
				`INSERT INTO cost_sources (id, org_id, provider, connection_ref, account_id, created_at, updated_at)
				 VALUES ('0190f2b3-0000-7000-8000-00000000000b', 'org_b', 'aws', $1, '123456789012', now(), now())`,
				[CONNECTION_A],
			)
			yield* poll
			assert.deepStrictEqual(Arr.dedupe(Arr.map(h.pulls, (pull) => pull.orgId)), ["org_a"])
			assert.deepStrictEqual(Arr.dedupe(h.tenants), ["org_a"])
			assert.isTrue(Arr.every(h.writtenRows(), (row) => row.OrgId === "org_a"))
			assert.deepStrictEqual(yield* h.sourceRefs, [["org_a", CONNECTION_A, "123456789012"]])
		}).pipe(Effect.provide(h.layer))
	})
})

describe("CostSyncService", () => {
	it.effect("first pulls the open months, then two months of history, and sets the frontiers", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectA(h)
			const summary = yield* poll
			assert.deepStrictEqual(h.windows(), [
				["2026-10-01", "2026-11-11"],
				["2026-09-01", "2026-09-30"],
				["2026-08-01", "2026-08-31"],
			])
			assert.deepStrictEqual(
				Arr.dedupe(Arr.map(h.pulls, (pull) => `${pull.orgId}|${pull.connectionRef}`)),
				[`org_a|${CONNECTION_A}`],
			)
			assert.deepStrictEqual(summary, {
				due: 1,
				synced: 1,
				skipped: 0,
				failures: 0,
				rowsWritten: 42 + 30 + 31,
				requests: 3 * REQUESTS_PER_PULL,
			})
			assert.deepStrictEqual(Arr.dedupe(h.datasources), ["cost_daily"])
			assert.deepStrictEqual(
				Arr.map(h.writtenRows(), (row) => row.Date),
				Arr.map(
					[
						...daysOfWindow({ startDay: "2026-10-01", endDay: "2026-11-11" }),
						...daysOfWindow({ startDay: "2026-09-01", endDay: "2026-09-30" }),
						...daysOfWindow({ startDay: "2026-08-01", endDay: "2026-08-31" }),
					],
					(day) => `${day} 00:00:00`,
				),
			)
			const today = Arr.findFirst(h.writtenRows(), (row) => row.Date === "2026-11-11 00:00:00")
			assert.deepStrictEqual(
				Option.map(today, (row) => ({ ...row, SourceId: "" })),
				Option.some({
					OrgId: "org_a",
					SourceId: "",
					Provider: "aws",
					AccountId: "123456789012",
					Date: "2026-11-11 00:00:00",
					CloudService: "Amazon Simple Storage Service",
					ChargeCategory: "usage",
					Currency: "USD",
					BilledCost: 3,
					EffectiveCost: 3,
					Estimated: 1,
					IngestedAt: "2026-11-11 12:00:00.000",
				}),
			)
			assert.deepStrictEqual(yield* h.sourceState, {
				watermark: "2026-11-11",
				backfill: "2026-08-01",
				synced: String(NOW),
				settled: String(NOW),
				lease: null,
				next: null,
				failures: 0,
				error: null,
				reason: null,
				month: "2026-11",
				requests: 3 * REQUESTS_PER_PULL,
			})
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("walks the backfill on a tick within a day, then re-pulls the head a day on", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectA(h)
			yield* poll
			yield* TestClock.adjust("1 hour")
			const before = h.pulls.length
			yield* poll
			assert.deepStrictEqual(h.windows().slice(before), [
				["2026-07-01", "2026-07-31"],
				["2026-06-01", "2026-06-30"],
				["2026-05-01", "2026-05-31"],
			])
			const walked = yield* h.sourceState
			assert.deepStrictEqual(
				[walked?.watermark, walked?.backfill, walked?.synced],
				["2026-11-11", "2026-05-01", String(NOW)],
			)
			// A day after the first pull: the last four days, then history again.
			yield* TestClock.adjust("23 hours")
			const beforeHead = h.pulls.length
			yield* poll
			assert.deepStrictEqual(h.windows().slice(beforeHead), [
				["2026-11-09", "2026-11-12"],
				["2026-04-01", "2026-04-30"],
				["2026-03-01", "2026-03-31"],
			])
			const head = yield* h.sourceState
			assert.deepStrictEqual(
				[head?.watermark, head?.backfill, head?.synced, head?.settled],
				["2026-11-12", "2026-03-01", String(NOW + 24 * HOUR_MS), String(NOW)],
			)
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("leaves a source with nothing due alone", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectA(h)
			yield* poll
			yield* h.sql("UPDATE cost_sources SET backfill_date = '2025-10-01'")
			yield* TestClock.adjust("1 hour")
			const before = h.pulls.length
			const summary = yield* poll
			assert.deepStrictEqual([summary.due, h.pulls.length], [0, before])
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("writes each step under one pull version of its own", () => {
		const h = harness({ pullTakesASecond: true })
		return Effect.gen(function* () {
			yield* connectA(h)
			yield* poll
			const versionsOf = (month: string) =>
				Arr.dedupe(
					Arr.map(
						Arr.filter(h.writtenRows(), (row) => Str.startsWith(month)(row.Date)),
						(row) => row.IngestedAt,
					),
				)
			// The settle step spans two months and is still one version.
			assert.deepStrictEqual(versionsOf("2026-10"), ["2026-11-11 12:00:00.000"])
			assert.deepStrictEqual(versionsOf("2026-11"), ["2026-11-11 12:00:00.000"])
			assert.deepStrictEqual(versionsOf("2026-09"), ["2026-11-11 12:00:01.000"])
			assert.deepStrictEqual(versionsOf("2026-08"), ["2026-11-11 12:00:02.000"])
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("writes a zero row for a day the provider returned nothing for", () => {
		const h = harness({ emptyDays: ["2026-10-15"] })
		return Effect.gen(function* () {
			yield* connectA(h)
			const summary = yield* poll
			assert.strictEqual(summary.rowsWritten, 42 + 30 + 31)
			const written = Arr.filter(h.writtenRows(), (row) => row.Date === "2026-10-15 00:00:00")
			assert.deepStrictEqual(
				Arr.map(written, (row) => [
					row.CloudService,
					row.ChargeCategory,
					row.Currency,
					row.BilledCost,
					row.EffectiveCost,
					row.Estimated,
					row.IngestedAt,
				]),
				[["", "none", "", 0, 0, 0, "2026-11-11 12:00:00.000"]],
			)
			// Every other day has the provider's row and no marker.
			assert.isFalse(
				Arr.some(
					h.writtenRows(),
					(row) => row.Date !== "2026-10-15 00:00:00" && row.CloudService === "",
				),
			)
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("writes no row of a day the provider returned outside the window it was asked for", () => {
		// Today's row comes back with the history pulls too: written, it would replace today with one row.
		const h = harness({ strayDays: ["2026-11-11"], emptyDays: ["2026-11-11"] })
		return Effect.gen(function* () {
			yield* connectA(h)
			const summary = yield* poll
			assert.lengthOf(h.pulls, 3)
			assert.strictEqual(summary.rowsWritten, 42 + 30 + 31)
			assert.deepStrictEqual(
				Arr.map(
					Arr.filter(h.writtenRows(), (row) => row.Date === "2026-11-11 00:00:00"),
					(row) => row.IngestedAt,
				),
				["2026-11-11 12:00:00.000"],
			)
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("leaves a source another tick holds, and two concurrent ticks sync it once", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectA(h)
			yield* poll
			yield* seedSynced(h, NOW)
			yield* h.sql("UPDATE cost_sources SET lease_until = to_timestamp($1 / 1000.0)", [
				NOW + 10 * 60_000,
			])
			const before = h.pulls.length
			const held = yield* poll
			assert.deepStrictEqual([held.due, h.pulls.length], [0, before])

			yield* h.sql("UPDATE cost_sources SET lease_until = NULL")
			const ticks = yield* Effect.all([poll, poll], { concurrency: "unbounded" })
			assert.strictEqual(
				Arr.reduce(ticks, 0, (sum, tick) => sum + tick.synced),
				1,
			)
			assert.strictEqual(h.pulls.length, before + 3)
		}).pipe(Effect.provide(h.layer))
	})
})

describe("CostSyncService failures", () => {
	it.effect(
		"records a provider failure, counts its requests, holds the source and keeps the frontiers",
		() => {
			const h = harness({ failReason: "not_ready", failRequests: 1 })
			return Effect.gen(function* () {
				yield* connectA(h)
				yield* poll
				const lastSynced = NOW - 25 * HOUR_MS
				yield* seedSynced(h, lastSynced)
				yield* h.sql("UPDATE cost_sources SET watermark_date = '2026-11-10', next_attempt_at = NULL")
				const summary = yield* poll
				assert.deepStrictEqual(
					[summary.failures, summary.synced, summary.rowsWritten, summary.requests],
					[1, 0, 0, 1],
				)
				assert.lengthOf(h.writes, 0)
				assert.deepStrictEqual(yield* h.sourceState, {
					watermark: "2026-11-10",
					backfill: "2026-10-01",
					synced: String(lastSynced),
					settled: String(lastSynced),
					lease: null,
					next: String(NOW + 6 * HOUR_MS),
					failures: 2,
					error: "The provider answered not_ready",
					reason: "not_ready",
					month: "2026-11",
					requests: 2,
				})
				// Still held five hours on, due again after six.
				yield* TestClock.adjust("5 hours")
				assert.strictEqual((yield* poll).due, 0)
				yield* TestClock.adjust("1 hour")
				assert.strictEqual((yield* poll).due, 1)
			}).pipe(Effect.provide(h.layer))
		},
	)

	it.effect("holds a throttled source an hour, and any other failure for the claim's backoff", () => {
		const throttled = harness({ failReason: "rate_limited" })
		const tooLarge = harness({ failReason: "too_large" })
		const failing = harness({ failReason: "upstream" })
		return Effect.gen(function* () {
			yield* connectA(throttled).pipe(Effect.andThen(poll), Effect.provide(throttled.layer))
			const held = yield* throttled.sourceState
			assert.deepStrictEqual([held?.reason, held?.next], ["rate_limited", String(NOW + HOUR_MS)])

			// A pull too large to read is billed on every try: it waits a day, not the 15 minute backoff.
			yield* connectA(tooLarge).pipe(Effect.andThen(poll), Effect.provide(tooLarge.layer))
			const large = yield* tooLarge.sourceState
			assert.deepStrictEqual([large?.reason, large?.next], ["too_large", String(NOW + 24 * HOUR_MS)])

			yield* connectA(failing).pipe(Effect.andThen(poll), Effect.provide(failing.layer))
			assert.strictEqual((yield* failing.sourceState)?.next, String(NOW + 15 * 60_000))
			// The backoff doubles with the second failure in a row.
			yield* TestClock.adjust("15 minutes")
			yield* poll.pipe(Effect.provide(failing.layer))
			const second = yield* failing.sourceState
			assert.deepStrictEqual(
				[second?.failures, second?.next],
				[2, String(NOW + 15 * 60_000 + 30 * 60_000)],
			)
		})
	})

	it.effect("keeps the steps before a failed one and records the failure", () => {
		const h = harness({ failWindowsFrom: ["2026-09-01"] })
		return Effect.gen(function* () {
			yield* connectA(h)
			const summary = yield* poll
			assert.deepStrictEqual(
				[summary.failures, summary.rowsWritten, summary.requests],
				[1, 42, REQUESTS_PER_PULL + 1],
			)
			assert.deepStrictEqual(h.windows(), [
				["2026-10-01", "2026-11-11"],
				["2026-09-01", "2026-09-30"],
			])
			const state = yield* h.sourceState
			assert.deepStrictEqual(
				[state?.watermark, state?.backfill, state?.synced, state?.reason, state?.requests],
				["2026-11-11", "2026-10-01", String(NOW), "upstream", REQUESTS_PER_PULL + 1],
			)
			assert.isFalse(Arr.some(h.writtenRows(), (row) => row.Date < "2026-10-01"))
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("a write the warehouse refuses moves no frontier and still counts the pull", () => {
		const h = harness({ failIngest: true })
		return Effect.gen(function* () {
			yield* connectA(h)
			const summary = yield* settleWithClock(yield* Effect.forkChild(poll))
			assert.deepStrictEqual([summary.failures, summary.rowsWritten], [1, 0])
			assert.lengthOf(h.pulls, 1)
			const state = yield* h.sourceState
			assert.deepStrictEqual(
				[
					state?.watermark,
					state?.backfill,
					state?.synced,
					state?.reason,
					state?.requests,
					state?.lease,
				],
				[null, null, null, "write", REQUESTS_PER_PULL, null],
			)
			assert.strictEqual(state?.error, "Maple could not store the cost rows: 503")
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("writes nothing once another tick took the row over", () => {
		const h = harness({ stealLease: true })
		return Effect.gen(function* () {
			yield* connectA(h)
			const summary = yield* poll
			assert.deepStrictEqual([summary.skipped, summary.synced, summary.rowsWritten], [1, 0, 0])
			assert.lengthOf(h.pulls, 1)
			assert.lengthOf(h.writes, 0)
			// The successor's lease and the row's state are as the pull left them.
			assert.deepStrictEqual(yield* h.sourceState, {
				watermark: null,
				backfill: null,
				synced: null,
				settled: null,
				lease: String(NOW + 14 * 60_000),
				next: String(NOW + 15 * 60_000),
				failures: 1,
				error: null,
				reason: null,
				month: null,
				requests: 0,
			})
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("a claim that moved a frontier before failing starts the backoff over", () => {
		const h = harness({ failWindowsFrom: ["2026-09-01"] })
		return Effect.gen(function* () {
			yield* connectA(h)
			// A source that failed three times in a row: its next claim would wait two hours.
			yield* h.sql(
				`INSERT INTO cost_sources (id, org_id, provider, connection_ref, account_id, consecutive_failures, created_at, updated_at)
				 VALUES ('0190f2b3-0000-7000-8000-00000000000a', 'org_a', 'aws', $1, '123456789012', 3, now(), now())`,
				[CONNECTION_A],
			)
			const summary = yield* poll
			assert.deepStrictEqual([summary.failures, summary.rowsWritten], [1, 42])
			const state = yield* h.sourceState
			assert.deepStrictEqual(
				[state?.watermark, state?.failures, state?.next, state?.reason, state?.error],
				["2026-11-11", 0, String(NOW + 15 * 60_000), "upstream", "The provider answered upstream"],
			)
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("a claim that failed before moving anything keeps counting", () => {
		const h = harness({ failReason: "upstream" })
		return Effect.gen(function* () {
			yield* connectA(h)
			yield* h.sql(
				`INSERT INTO cost_sources (id, org_id, provider, connection_ref, account_id, consecutive_failures, created_at, updated_at)
				 VALUES ('0190f2b3-0000-7000-8000-00000000000a', 'org_a', 'aws', $1, '123456789012', 3, now(), now())`,
				[CONNECTION_A],
			)
			yield* poll
			const state = yield* h.sourceState
			assert.deepStrictEqual([state?.failures, state?.next], [4, String(NOW + 2 * HOUR_MS)])
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("adds requests within a month and starts over in the next", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-30T12:00:00Z")))
			yield* h.connect({ id: CONNECTION_A })
			yield* poll
			yield* TestClock.adjust("1 hour")
			yield* poll
			const november = yield* h.sourceState
			assert.deepStrictEqual([november?.month, november?.requests], ["2026-11", 6 * REQUESTS_PER_PULL])
			// Past midnight UTC into December: the head is due, and its requests open the new month.
			yield* TestClock.adjust("23 hours")
			yield* poll
			const december = yield* h.sourceState
			assert.deepStrictEqual([december?.month, december?.requests], ["2026-12", 3 * REQUESTS_PER_PULL])
		}).pipe(Effect.provide(h.layer))
	})
})

describe("CostSyncService rollout", () => {
	const ROLLOUT_ERROR = "Cloud cost is not enabled for this organization."

	it.effect("pulls nothing for an org that lost the cloudCost rollout, and holds its source", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectA(h)
			yield* poll
			// History is left to walk, so the source is due on the next tick.
			yield* h.sql("UPDATE cost_sources SET consecutive_failures = 2")
			yield* h.setCloudCost("org_a", false)
			yield* TestClock.adjust("1 hour")
			const before = yield* h.sourceState
			const [pulls, writes] = [h.pulls.length, h.writes.length]
			const held = yield* poll
			assert.deepStrictEqual(held, {
				due: 1,
				synced: 0,
				skipped: 1,
				failures: 0,
				rowsWritten: 0,
				requests: 0,
			})
			assert.deepStrictEqual([h.pulls.length, h.writes.length], [pulls, writes])
			// The frontiers and the request count as they were, and the claim's failure not counted.
			assert.deepStrictEqual(yield* h.sourceState, {
				...before,
				next: String(NOW + 7 * HOUR_MS),
				error: ROLLOUT_ERROR,
				reason: "rollout",
			})
			assert.deepStrictEqual(
				[before?.failures, before?.lease, before?.watermark],
				[2, null, "2026-11-11"],
			)

			// Still held five hours on; asked again after six, and held again without a pull.
			yield* TestClock.adjust("5 hours")
			assert.strictEqual((yield* poll).due, 0)
			yield* TestClock.adjust("1 hour")
			const again = yield* poll
			assert.deepStrictEqual([again.due, again.skipped, again.failures], [1, 1, 0])
			assert.deepStrictEqual([h.pulls.length, h.writes.length], [pulls, writes])
			assert.deepStrictEqual(yield* h.sourceState, {
				...before,
				next: String(NOW + 13 * HOUR_MS),
				error: ROLLOUT_ERROR,
				reason: "rollout",
			})
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("syncs again once the org is back in the rollout, and clears the hold", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectA(h)
			yield* h.setCloudCost("org_a", false)
			// The first claim the source ever gets: nothing is pulled, no frontier is set.
			yield* poll
			const held = yield* h.sourceState
			assert.deepStrictEqual(
				[h.pulls.length, held?.watermark, held?.backfill, held?.reason, held?.failures],
				[0, null, null, "rollout", 0],
			)
			yield* h.setCloudCost("org_a", true)
			// The hold stands until it runs out, then the claim proceeds as any other.
			yield* TestClock.adjust("5 hours")
			assert.deepStrictEqual([(yield* poll).due, h.pulls.length], [0, 0])
			yield* TestClock.adjust("1 hour")
			const summary = yield* poll
			assert.deepStrictEqual([summary.synced, summary.failures], [1, 0])
			assert.deepStrictEqual(h.windows(), [
				["2026-10-01", "2026-11-11"],
				["2026-09-01", "2026-09-30"],
				["2026-08-01", "2026-08-31"],
			])
			const state = yield* h.sourceState
			assert.deepStrictEqual(
				[state?.watermark, state?.error, state?.reason, state?.next, state?.failures],
				["2026-11-11", null, null, null, 0],
			)
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("holds only the sources of the org that lost the rollout", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectA(h)
			yield* h.connect({ id: CONNECTION_B, orgId: "org_b", account: "210987654321" })
			yield* h.setCloudCost("org_b", false)
			const summary = yield* poll
			assert.deepStrictEqual([summary.due, summary.synced, summary.skipped], [2, 1, 1])
			assert.deepStrictEqual(Arr.dedupe(Arr.map(h.pulls, (pull) => pull.orgId)), ["org_a"])
			assert.deepStrictEqual(Arr.dedupe(h.tenants), ["org_a"])
			const [a, b] = [yield* h.sourceState, yield* h.sourceStateOf("org_b", CONNECTION_B)]
			assert.deepStrictEqual([a?.watermark, a?.error, a?.reason], ["2026-11-11", null, null])
			assert.deepStrictEqual(
				[b?.watermark, b?.error, b?.reason, b?.next],
				[null, ROLLOUT_ERROR, "rollout", String(NOW + 6 * HOUR_MS)],
			)
		}).pipe(Effect.provide(h.layer))
	})
})

describe("CostSyncService request budgets", () => {
	const setRequests = (h: ReturnType<typeof harness>, count: number) =>
		h.sql("UPDATE cost_sources SET requests_count = $1", [count])

	it.effect("stops walking history once the backfill budget is reached, mid-claim", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectA(h)
			yield* poll
			// Two more pulls reach the budget; the third step of the claim is not taken.
			yield* setRequests(h, BACKFILL_REQUEST_BUDGET - 2 * REQUESTS_PER_PULL)
			yield* TestClock.adjust("1 hour")
			const before = h.pulls.length
			const summary = yield* poll
			assert.deepStrictEqual(h.windows().slice(before), [
				["2026-07-01", "2026-07-31"],
				["2026-06-01", "2026-06-30"],
			])
			assert.strictEqual(summary.synced, 1)
			const state = yield* h.sourceState
			// Held until the head is next due; not an error, not a failure.
			assert.deepStrictEqual(
				[state?.backfill, state?.requests, state?.next, state?.failures, state?.error, state?.reason],
				["2026-06-01", BACKFILL_REQUEST_BUDGET, String(NOW + 23 * HOUR_MS), 0, null, null],
			)
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("past the backfill budget it is claimed once, then only for its daily head", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectA(h)
			yield* poll
			yield* setRequests(h, BACKFILL_REQUEST_BUDGET)
			yield* h.sql("UPDATE cost_sources SET consecutive_failures = 2")
			yield* TestClock.adjust("1 hour")
			const before = h.pulls.length
			const held = yield* poll
			assert.deepStrictEqual([held.due, held.skipped, held.failures, h.pulls.length], [1, 1, 0, before])
			const state = yield* h.sourceState
			assert.deepStrictEqual(
				[state?.next, state?.failures, state?.error, state?.reason, state?.lease],
				[String(NOW + 23 * HOUR_MS), 2, null, null, null],
			)
			// Not selected again while it waits.
			yield* TestClock.adjust("1 hour")
			assert.strictEqual((yield* poll).due, 0)
			// The head still runs when it is due, and history stays where it was.
			yield* TestClock.adjust("21 hours")
			const head = yield* poll
			assert.strictEqual(head.synced, 1)
			assert.deepStrictEqual(h.windows().slice(before), [["2026-11-09", "2026-11-12"]])
			assert.strictEqual((yield* h.sourceState)?.backfill, "2026-08-01")
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("at the monthly budget it pulls nothing until the next month, then starts over", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectA(h)
			yield* poll
			yield* setRequests(h, MONTHLY_REQUEST_BUDGET)
			yield* h.sql("UPDATE cost_sources SET consecutive_failures = 2")
			yield* TestClock.adjust("1 hour")
			const before = h.pulls.length
			const held = yield* poll
			assert.deepStrictEqual([held.due, held.skipped, held.failures, h.pulls.length], [1, 1, 0, before])
			const december = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-12-01T00:00:00Z"))
			const state = yield* h.sourceState
			assert.deepStrictEqual(
				[state?.next, state?.failures, state?.reason, state?.lease, state?.watermark],
				[String(december), 2, "budget", null, "2026-11-11"],
			)
			assert.include(state?.error, "budget")
			// Not even the head, a day and a week on.
			yield* TestClock.adjust("1 day")
			assert.strictEqual((yield* poll).due, 0)
			yield* TestClock.adjust("7 days")
			assert.deepStrictEqual([(yield* poll).due, h.pulls.length], [0, before])

			// The first hour of December: the count starts over and the source catches up.
			yield* TestClock.setTime(december)
			const resumed = yield* poll
			assert.strictEqual(resumed.synced, 1)
			assert.deepStrictEqual(h.windows()[before], ["2026-11-01", "2026-12-01"])
			const after = yield* h.sourceState
			assert.deepStrictEqual(
				[after?.month, after?.requests, after?.next, after?.failures, after?.error, after?.reason],
				["2026-12", 3 * REQUESTS_PER_PULL, null, 0, null, null],
			)
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("reaching the monthly budget mid-claim keeps what was pulled and holds the rest", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectA(h)
			yield* poll
			// The head is due and its pull spends the last of the budget: no history step follows.
			yield* setRequests(h, MONTHLY_REQUEST_BUDGET - REQUESTS_PER_PULL)
			yield* TestClock.adjust("23 hours")
			const before = h.pulls.length
			const summary = yield* poll
			assert.deepStrictEqual(h.windows().slice(before), [["2026-11-09", "2026-11-12"]])
			assert.deepStrictEqual([summary.synced, summary.failures], [1, 0])
			const state = yield* h.sourceState
			assert.deepStrictEqual(
				[state?.watermark, state?.requests, state?.reason, state?.failures],
				["2026-11-12", MONTHLY_REQUEST_BUDGET, "budget", 0],
			)
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("a hold that ends with nothing due does not stay on as an error", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-29T20:00:00Z")))
			yield* h.connect({ id: CONNECTION_A })
			yield* poll
			// History is done, and the next day's head spends the last of the budget.
			yield* h.sql("UPDATE cost_sources SET backfill_date = '2025-10-01'")
			yield* setRequests(h, MONTHLY_REQUEST_BUDGET - REQUESTS_PER_PULL)
			yield* TestClock.adjust("1 day")
			yield* poll
			assert.strictEqual((yield* h.sourceState)?.reason, "budget")
			// December's first hour: the head is four hours old, so there is nothing to pull.
			yield* TestClock.adjust("4 hours")
			const before = h.pulls.length
			const summary = yield* poll
			assert.deepStrictEqual([summary.due, summary.skipped, h.pulls.length], [1, 1, before])
			const state = yield* h.sourceState
			assert.deepStrictEqual([state?.error, state?.reason, state?.next], [null, null, null])
			// Cleared once: it is not claimed again until its head is due.
			yield* TestClock.adjust("1 hour")
			assert.strictEqual((yield* poll).due, 0)
		}).pipe(Effect.provide(h.layer))
	})
})
