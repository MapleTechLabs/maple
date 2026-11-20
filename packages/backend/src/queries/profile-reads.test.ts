import * as Policy from "@maple/domain/policy"
import { describe, expect, it } from "@effect/vitest"
import {
	ProfileSampleTypesRequest,
	ProfileStacksRequest,
	WarehouseConfigError,
	type TenantContext,
} from "@maple/domain/http"
import { OrgId, UserId } from "@maple/primitives"
import { CH } from "@maple/query-engine"
import {
	compiledQueryOf,
	type CompiledQueryInput,
	WarehouseResponseLimitError,
	type WarehouseResponseLimits,
} from "@maple/query-engine/execution"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import type { QueryEngineServiceApi } from "@maple/backend/services/warehouse/QueryEngineService"
import { Effect, Option, Schema, Array as Arr, String as Str } from "effect"
import { makeProfileReads, PROFILE_STACKS_FALLBACK_CAP, PROFILE_STACKS_RESPONSE_BYTES } from "./profile-reads"

const tenant: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_profile_reads"),
	userId: Schema.decodeSync(UserId)("user_profile_reads"),
	roles: [],
	permissions: Policy.grantsOf([]),
	authMode: "self_hosted",
}

const WINDOW = { startTime: "2026-11-15 11:00:00", endTime: "2026-11-15 12:00:00" }
const service = Schema.decodeSync(ProfileSampleTypesRequest)({ ...WINDOW, serviceName: "checkout-api" })
const serviceStacks = Schema.decodeSync(ProfileStacksRequest)({
	...WINDOW,
	serviceName: "checkout-api",
	sampleType: "cpu",
	sampleUnit: "nanoseconds",
})
const spanStacks = Schema.decodeSync(ProfileStacksRequest)({
	...WINDOW,
	traceId: "7f3a4b5c6d7e8f901234567890abcdef",
	spanIds: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"],
	sampleType: "cpu",
	sampleUnit: "nanoseconds",
})

type Rows = ReadonlyArray<Record<string, unknown>>

const stackRow = (index: number, totalStacks: number) => ({
	stackHash: String(index),
	frames: ["main", `work${index}`],
	files: ["/app/src/main.ts", ""],
	lines: [3, 0],
	value: 100 - index,
	samples: 1,
	totalValue: 5000,
	totalStacks,
})

interface BoundedCall {
	readonly sql: string
	readonly limits: WarehouseResponseLimits
}

/** A warehouse answering from `rowsFor`, recording each statement and the limits it ran under. */
const makeWarehouse = (
	rowsFor: (sql: string) => Effect.Effect<Rows, WarehouseConfigError | WarehouseResponseLimitError>,
) => {
	const statements: string[] = []
	const bounded: BoundedCall[] = []
	const decode = (compiled: CompiledQueryInput<unknown>) => {
		const query = compiledQueryOf(compiled)
		statements.push(query.sql)
		return rowsFor(query.sql).pipe(Effect.flatMap((rows) => query.decodeRows(rows).pipe(Effect.orDie)))
	}
	const warehouse = makeWarehouseServiceStub({
		// SAFETY: these reads hand the stub a plain compiled query, never a capability compile.
		compiledQuery: ((_tenant: unknown, compiled: CompiledQueryInput<unknown>) =>
			decode(compiled)) as never,
		// SAFETY: as above.
		compiledQueryBounded: ((
			_tenant: unknown,
			compiled: CompiledQueryInput<unknown>,
			options: { readonly responseLimits: WarehouseResponseLimits },
		) => {
			bounded.push({ sql: compiledQueryOf(compiled).sql, limits: options.responseLimits })
			return decode(compiled)
		}) as never,
	})
	return { warehouse, statements, bounded }
}

/** The query engine as the reads see it: `cachedDirect` runs the compute. */
const queryEngine: QueryEngineServiceApi = {
	execute: () => Effect.die("execute is not used by these reads"),
	evaluate: () => Effect.die("evaluate is not used by these reads"),
	evaluateSeries: () => Effect.die("evaluateSeries is not used by these reads"),
	cachedDirect: (_tenant, _route, _payload, effect) => effect,
}

const missingProfilesTable = new WarehouseConfigError({
	message: "Table default.profiles does not exist",
	pipeName: "profileSampleTypes",
	clickhouseType: "UNKNOWN_TABLE",
})

const overBytes = new WarehouseResponseLimitError({ kind: "bytes", message: "too large" })

/** The row cap a statement asked the warehouse for. */
const limitOf = (sql: string): number =>
	Option.match(Str.match(/LIMIT (\d+)/)(sql), {
		onNone: () => Number.NaN,
		onSome: (match) => Number(match[1]),
	})

describe("makeProfileReads.sampleTypes", () => {
	it.effect("reads the service's sample types inside the caller's org", () =>
		Effect.gen(function* () {
			const { warehouse, statements } = makeWarehouse(() =>
				Effect.succeed([
					{
						sampleType: "cpu",
						sampleUnit: "nanoseconds",
						value: 4000,
						samples: 40,
						profiles: 2,
						durationNano: 10_000,
					},
				]),
			)
			const rows = yield* makeProfileReads({ warehouse, queryEngine }).sampleTypes(tenant, service)
			expect(Arr.map(rows, (row) => [row.sampleType, row.sampleUnit, row.durationNano])).toEqual([
				["cpu", "nanoseconds", 10_000],
			])
			expect(statements).toHaveLength(1)
			expect(statements[0]).toContain("OrgId = 'org_profile_reads'")
			expect(statements[0]).toContain("ServiceName = 'checkout-api'")
		}),
	)

	it.effect("a cluster without the profiles table has no sample types", () =>
		Effect.gen(function* () {
			const { warehouse } = makeWarehouse(() => Effect.fail(missingProfilesTable))
			const rows = yield* makeProfileReads({ warehouse, queryEngine }).sampleTypes(tenant, service)
			expect(rows).toEqual([])
		}),
	)

	it.effect("refuses a read that names neither a service nor a trace's spans", () =>
		Effect.gen(function* () {
			const { warehouse, statements } = makeWarehouse(() => Effect.succeed([]))
			const reads = makeProfileReads({ warehouse, queryEngine })
			const orgWide = yield* Effect.flip(
				reads.sampleTypes(tenant, Schema.decodeSync(ProfileSampleTypesRequest)(WINDOW)),
			)
			expect(orgWide._tag).toBe("@maple/http/errors/QueryEngineValidationError")
			// A trace without span ids would read every sample of the trace's window.
			const traceOnly = yield* Effect.flip(
				reads.stacks(
					tenant,
					Schema.decodeSync(ProfileStacksRequest)({
						...WINDOW,
						traceId: "7f3a4b5c6d7e8f901234567890abcdef",
						sampleType: "cpu",
						sampleUnit: "nanoseconds",
					}),
				),
			)
			expect(traceOnly._tag).toBe("@maple/http/errors/QueryEngineValidationError")
			expect(statements).toEqual([])
		}),
	)
})

describe("makeProfileReads.stacks", () => {
	it.effect("bounds the read in rows and bytes, and says when the cap cut stacks off", () =>
		Effect.gen(function* () {
			const { warehouse, bounded } = makeWarehouse(() =>
				Effect.succeed([stackRow(0, 7000), stackRow(1, 7000)]),
			)
			const read = yield* makeProfileReads({ warehouse, queryEngine }).stacks(tenant, serviceStacks)
			expect(read).toEqual({
				stacks: [
					{ frames: ["main", "work0"], files: ["/app/src/main.ts", ""], lines: [3, 0], value: 100 },
					{ frames: ["main", "work1"], files: ["/app/src/main.ts", ""], lines: [3, 0], value: 99 },
				],
				totalValue: 5000,
				totalStacks: 7000,
				truncated: true,
			})
			expect(Arr.map(bounded, (call) => call.limits)).toEqual([
				{ maxRows: CH.PROFILE_STACKS_CAP, maxBytes: PROFILE_STACKS_RESPONSE_BYTES },
			])
			expect(limitOf(bounded[0]?.sql ?? "")).toBe(CH.PROFILE_STACKS_CAP)
			expect(bounded[0]?.sql).toContain("OrgId = 'org_profile_reads'")
		}),
	)

	it.effect("reads one unit of the sample type, so two units of it are never added together", () =>
		Effect.gen(function* () {
			const { warehouse, bounded } = makeWarehouse(() => Effect.succeed([stackRow(0, 1)]))
			const reads = makeProfileReads({ warehouse, queryEngine })
			yield* reads.stacks(tenant, serviceStacks)
			yield* reads.stacks(
				tenant,
				Schema.decodeSync(ProfileStacksRequest)({
					...WINDOW,
					serviceName: "checkout-api",
					sampleType: "cpu",
					sampleUnit: "count",
				}),
			)
			// A profile whose export named no unit is stored with an empty one.
			yield* reads.stacks(
				tenant,
				Schema.decodeSync(ProfileStacksRequest)({
					...WINDOW,
					serviceName: "checkout-api",
					sampleType: "unknown",
					sampleUnit: "",
				}),
			)
			const [nanoseconds = "", count = "", unnamed = ""] = Arr.map(bounded, (call) => call.sql)
			expect(nanoseconds).toContain("SampleType = 'cpu'")
			expect(nanoseconds).toContain("SampleUnit = 'nanoseconds'")
			expect(count).toContain("SampleType = 'cpu'")
			expect(count).toContain("SampleUnit = 'count'")
			expect(unnamed).toContain("SampleType = 'unknown'")
			expect(unnamed).toContain("SampleUnit = ''")
		}),
	)

	it.effect("the fewer-stacks retry reads the same unit", () =>
		Effect.gen(function* () {
			const { warehouse, bounded } = makeWarehouse((sql) =>
				limitOf(sql) > PROFILE_STACKS_FALLBACK_CAP
					? Effect.fail(overBytes)
					: Effect.succeed([stackRow(0, 7000)]),
			)
			yield* makeProfileReads({ warehouse, queryEngine }).stacks(tenant, serviceStacks)
			expect(bounded).toHaveLength(2)
			expect(bounded[1]?.sql).toContain("SampleUnit = 'nanoseconds'")
		}),
	)

	it.effect("scopes a span read to the trace and the named spans", () =>
		Effect.gen(function* () {
			const { warehouse, bounded } = makeWarehouse(() => Effect.succeed([stackRow(0, 1)]))
			const read = yield* makeProfileReads({ warehouse, queryEngine }).stacks(tenant, spanStacks)
			expect(read.truncated).toBe(false)
			const sql = bounded[0]?.sql ?? ""
			expect(sql).toContain("OrgId = 'org_profile_reads'")
			expect(sql).toContain("TraceId = '7f3a4b5c6d7e8f901234567890abcdef'")
			expect(sql).toContain("'aaaaaaaaaaaaaaaa'")
			expect(sql).toContain("'bbbbbbbbbbbbbbbb'")
		}),
	)

	it.effect("reads fewer stacks when the full read is over the byte ceiling", () =>
		Effect.gen(function* () {
			const { warehouse, bounded } = makeWarehouse((sql) =>
				limitOf(sql) > PROFILE_STACKS_FALLBACK_CAP
					? Effect.fail(overBytes)
					: Effect.succeed([stackRow(0, 7000)]),
			)
			const read = yield* makeProfileReads({ warehouse, queryEngine }).stacks(tenant, serviceStacks)
			expect(read.stacks).toHaveLength(1)
			expect(read.truncated).toBe(true)
			expect(Arr.map(bounded, (call) => call.limits.maxRows)).toEqual([
				CH.PROFILE_STACKS_CAP,
				PROFILE_STACKS_FALLBACK_CAP,
			])
		}),
	)

	it.effect("refuses stacks that are over the ceiling even at the smaller cap", () =>
		Effect.gen(function* () {
			const { warehouse, bounded } = makeWarehouse(() => Effect.fail(overBytes))
			const error = yield* Effect.flip(
				makeProfileReads({ warehouse, queryEngine }).stacks(tenant, serviceStacks),
			)
			expect(error._tag).toBe("@maple/http/errors/QueryEngineValidationError")
			expect(bounded).toHaveLength(2)
		}),
	)

	it.effect("a cluster without the profiles table has no stacks", () =>
		Effect.gen(function* () {
			const { warehouse } = makeWarehouse(() => Effect.fail(missingProfilesTable))
			const read = yield* makeProfileReads({ warehouse, queryEngine }).stacks(tenant, serviceStacks)
			expect(read).toEqual({ stacks: [], totalValue: 0, totalStacks: 0, truncated: false })
		}),
	)
})
