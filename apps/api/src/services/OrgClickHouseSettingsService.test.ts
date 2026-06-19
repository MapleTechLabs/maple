import { describe, expect, it } from "@effect/vitest"
import {
	OrgClickHouseSettingsUpstreamRejectedError,
	OrgClickHouseSettingsUpstreamUnavailableError,
} from "@maple/domain/http"
import { Cause, Effect, Exit, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { TableDiffEntry } from "@maple/domain/clickhouse"
import {
	type ClickHouseExecConfig,
	execClickHouse,
	isRetryableUpstream,
	shouldHealSchemaVersion,
} from "./OrgClickHouseSettingsService"

// `execClickHouse` runs through Effect's HttpClient. We inject a stub `fetch` via
// `FetchHttpClient.Fetch` (deterministic per run — no global mutation) and assert
// both the mapped error AND the number of fetch attempts, which is how we verify
// the retry policy (only transient gateway/network failures are retried, never
// timeouts or genuine ClickHouse SQL errors).

const CONFIG: ClickHouseExecConfig = {
	url: "https://clickhouse.example.test",
	user: "default",
	password: "secret",
	database: "maple",
}

const mockResponse = (body: string, status: number): Response => new Response(body, { status })

/** Build a stub `fetch` that runs `impl` and counts calls. */
const makeFetch = (impl: () => Promise<Response>) => {
	const state = { calls: 0 }
	const fetchImpl = (() => {
		state.calls += 1
		return impl()
	}) as typeof globalThis.fetch
	return { state, fetchImpl }
}

/** Run execClickHouse with the stub fetch injected. */
const run = (sql: string, fetchImpl: typeof globalThis.fetch) =>
	execClickHouse(CONFIG, sql).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchImpl))

const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined
	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	if (failure !== undefined) return failure
	return Cause.squash(exit.cause)
}

const unavailable = (statusCode: number | null) =>
	new OrgClickHouseSettingsUpstreamUnavailableError({ message: "x", statusCode })
const rejected = (statusCode: number | null) =>
	new OrgClickHouseSettingsUpstreamRejectedError({ message: "x", statusCode })

describe("shouldHealSchemaVersion", () => {
	const REV = "019c3db4cf690e3748b302098cae4c9213d18c55355db9fc68ea44982c7a980a"
	const STALE = "4d5d918315933608d316aa8d6e6b57948f15a3fdca2fa6226aa271553f0b0520"
	const upToDate = (name: string): TableDiffEntry => ({
		status: "up_to_date",
		name,
		kind: "table",
	})
	const inSync: ReadonlyArray<TableDiffEntry> = [upToDate("traces"), upToDate("logs")]

	it("heals when the live schema is in sync but the stored revision is stale", () => {
		// The exact production case: CH applied via the standalone CLI (so D1 was never
		// stamped) or a revision bump left it behind, yet every table is up_to_date.
		expect(shouldHealSchemaVersion(inSync, STALE, REV)).toBe(true)
		expect(shouldHealSchemaVersion(inSync, null, REV)).toBe(true)
	})

	it("does not heal when the stored revision already matches", () => {
		expect(shouldHealSchemaVersion(inSync, REV, REV)).toBe(false)
	})

	it("does not heal when any table is missing or drifted", () => {
		const missing: ReadonlyArray<TableDiffEntry> = [
			upToDate("traces"),
			{ status: "missing", name: "logs", kind: "table" },
		]
		const drifted: ReadonlyArray<TableDiffEntry> = [
			{ status: "drifted", name: "traces", kind: "table", columnDrifts: [] },
		]
		expect(shouldHealSchemaVersion(missing, STALE, REV)).toBe(false)
		expect(shouldHealSchemaVersion(drifted, STALE, REV)).toBe(false)
	})

	it("does not heal off an empty diff (degenerate / failed schema fetch)", () => {
		expect(shouldHealSchemaVersion([], STALE, REV)).toBe(false)
	})
})

describe("isRetryableUpstream", () => {
	it("retries transient gateway/proxy codes and network failures, nothing else", () => {
		// Transient → retry.
		expect(isRetryableUpstream(unavailable(null))).toBe(true) // connection reset/refused
		expect(isRetryableUpstream(unavailable(502))).toBe(true)
		expect(isRetryableUpstream(unavailable(503))).toBe(true)
		expect(isRetryableUpstream(unavailable(504))).toBe(true)
		expect(isRetryableUpstream(unavailable(520))).toBe(true)
		expect(isRetryableUpstream(unavailable(524))).toBe(true) // Cloudflare edge timeout
		expect(isRetryableUpstream(unavailable(529))).toBe(true)

		// Not transient → do not retry.
		expect(isRetryableUpstream(unavailable(408))).toBe(false) // our own timeout
		expect(isRetryableUpstream(unavailable(500))).toBe(false) // ClickHouse SQL error
		expect(isRetryableUpstream(unavailable(501))).toBe(false)
		expect(isRetryableUpstream(rejected(400))).toBe(false) // 4xx rejection
		expect(isRetryableUpstream(rejected(401))).toBe(false)
	})
})

describe("execClickHouse", () => {
	it.live("maps a Cloudflare 524 to a clear, actionable message (and retries 52x)", () =>
		Effect.gen(function* () {
			const { state, fetchImpl } = makeFetch(() =>
				Promise.resolve(mockResponse("error code: 524", 524)),
			)

			const exit = yield* run("SELECT 1", fetchImpl).pipe(Effect.exit)

			expect(Exit.isFailure(exit)).toBe(true)
			const err = getError(exit)
			expect(err).toBeInstanceOf(OrgClickHouseSettingsUpstreamUnavailableError)
			expect((err as OrgClickHouseSettingsUpstreamUnavailableError).statusCode).toBe(524)
			expect((err as OrgClickHouseSettingsUpstreamUnavailableError).message).toContain("Cloudflare 524")
			expect((err as OrgClickHouseSettingsUpstreamUnavailableError).message).toContain("allowlist")
			// 52x is transient → 1 initial attempt + 2 retries.
			expect(state.calls).toBe(3)
		}),
	)

	it.live("retries a transient 503 then succeeds", () =>
		Effect.gen(function* () {
			const { state, fetchImpl } = makeFetch(() =>
				Promise.resolve(
					state.calls === 1 ? mockResponse("bad gateway", 503) : mockResponse("ok", 200),
				),
			)

			const text = yield* run("SELECT 1", fetchImpl)

			expect(text).toBe("ok")
			expect(state.calls).toBe(2)
		}),
	)

	it.live("does NOT retry a 4xx rejection", () =>
		Effect.gen(function* () {
			const { state, fetchImpl } = makeFetch(() => Promise.resolve(mockResponse("Syntax error", 400)))

			const exit = yield* run("SELEKT 1", fetchImpl).pipe(Effect.exit)

			expect(Exit.isFailure(exit)).toBe(true)
			expect(getError(exit)).toBeInstanceOf(OrgClickHouseSettingsUpstreamRejectedError)
			expect(state.calls).toBe(1)
		}),
	)

	it.live("does NOT retry a ClickHouse 500 SQL error (carries the DB::Exception text)", () =>
		Effect.gen(function* () {
			const { state, fetchImpl } = makeFetch(() =>
				Promise.resolve(mockResponse("Code: 60. DB::Exception: UNKNOWN_TABLE", 500)),
			)

			const exit = yield* run("SELECT * FROM nope", fetchImpl).pipe(Effect.exit)

			expect(Exit.isFailure(exit)).toBe(true)
			const err = getError(exit)
			expect(err).toBeInstanceOf(OrgClickHouseSettingsUpstreamUnavailableError)
			expect((err as OrgClickHouseSettingsUpstreamUnavailableError).statusCode).toBe(500)
			// Generic upstream message, NOT the Cloudflare 52x guidance.
			expect((err as OrgClickHouseSettingsUpstreamUnavailableError).message).toContain(
				"ClickHouse upstream error (500)",
			)
			expect((err as OrgClickHouseSettingsUpstreamUnavailableError).message).not.toContain("Cloudflare")
			expect(state.calls).toBe(1)
		}),
	)
})
