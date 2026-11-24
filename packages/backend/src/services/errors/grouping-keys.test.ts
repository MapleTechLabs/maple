import { TraceMap } from "@jridgewell/trace-mapping"
import { compileGroupingRules, GroupingConfig, OrgGroupingRule } from "@maple/domain/tinybird/grouping-rules"
import { explainGrouping, groupingKey } from "@maple/domain/tinybird/grouping"
import { OrgId } from "@maple/domain/http"
import { Array as Arr, DateTime, Effect, Option, Order, Record as Rec, Schema, String as Str } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import * as PG from "@maple-dev/effect-orm/postgres"
import { ErrorFingerprintCandidates, ErrorGroupingKeys } from "@maple/db/tables"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import type { StackSymbolicatorApi } from "@maple/backend/services/sourcemaps/StackSymbolicator"
import { symbolicateStack } from "@maple/backend/services/sourcemaps/symbolicate"
import {
	computeSampleInputs,
	DEFAULT_ORG_GROUPING,
	type GroupingSampleRow,
	type GroupingSpanRow,
	MAP_PENDING_GRACE_MS,
	resolveGroupingSiblings,
	withSourceMappedStacks,
} from "./grouping-keys"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeSync(OrgId)("org_grouping_keys_test")
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** Base64 VLQ, as the source map v3 spec encodes each segment field. */
const vlq = (value: number): string => {
	const digits = (rest: number): ReadonlyArray<number> =>
		rest < 32 ? [rest] : [(rest & 31) | 32, ...digits(rest >>> 5)]
	return Arr.join(
		Arr.map(digits(value < 0 ? (-value << 1) | 1 : value << 1), (digit) => BASE64[digit] ?? ""),
		"",
	)
}

type Segment = readonly [genColumn: number, source: number, line: number, column: number, name: number]

/** One generated line of absolute (0-based) segments, every one named. */
const encodeLine = (segments: ReadonlyArray<Segment>): string =>
	Arr.join(
		Arr.map(segments, (segment, i) => {
			const previous = i === 0 ? ([0, 0, 0, 0, 0] as const) : (segments[i - 1] ?? segment)
			return Arr.join(
				Arr.map([0, 1, 2, 3, 4] as const, (field) => vlq(segment[field] - previous[field])),
				"",
			)
		}),
		",",
	)

/** One release's bundle: an app function at `appColumn`, a dependency's at `libColumn`. */
const release = (opts: {
	readonly bundle: string
	readonly appFunction: string
	readonly appSource?: string
	readonly appLine: number
	readonly appColumn: number
	readonly libColumn: number
	readonly libFunction?: string
	readonly noSourceText?: boolean
}) => ({
	url: `https://app.example.com/assets/${opts.bundle}.js`,
	map: new TraceMap({
		version: 3,
		file: `${opts.bundle}.js`,
		sources: [
			`webpack://web/./${opts.appSource ?? "src/invoice.ts"}`,
			"webpack://web/./node_modules/ky/index.js",
		],
		// The throw site's own text, wherever the release put it: what an unnamed frame keys on.
		sourcesContent: [
			opts.noSourceText === true
				? null
				: Arr.join(
						Arr.makeBy(opts.appLine + 1, (i) =>
							i === opts.appLine ? "  return invoice.total" : "",
						),
						"\n",
					),
			null,
		],
		names: [opts.appFunction, opts.libFunction ?? "request"],
		mappings: encodeLine([
			[opts.appColumn, 0, opts.appLine, 2, 0],
			[opts.libColumn, 1, 40, 4, 1],
		]),
	}),
	app: (minified: string) =>
		`${minified} (https://app.example.com/assets/${opts.bundle}.js:1:${opts.appColumn + 1})`,
	lib: (minified: string) =>
		`${minified} (https://app.example.com/assets/${opts.bundle}.js:1:${opts.libColumn + 1})`,
})

const V1 = release({
	bundle: "index-Bx81",
	appFunction: "renderInvoice",
	appLine: 6,
	appColumn: 0,
	libColumn: 40,
})
const V2 = release({
	bundle: "index-Qz07",
	appFunction: "renderInvoice",
	appLine: 19,
	appColumn: 120,
	libColumn: 900,
	libFunction: "retry",
})
const CART = release({
	bundle: "index-Qz07b",
	appFunction: "renderCart",
	appSource: "src/cart.ts",
	appLine: 3,
	appColumn: 7,
	libColumn: 60,
})
// No embedded source: a throw site with no caller maps, but has no identity to key on.
const BARE = release({
	bundle: "index-bare",
	appFunction: "renderInvoice",
	appLine: 6,
	appColumn: 0,
	libColumn: 40,
	noSourceText: true,
})
const MAPS = new Map(Arr.map([V1, V2, CART, BARE], (r) => [r.url, r.map] as const))

/** The symbolicator, over in-memory maps; counts its lookups and can fail them. */
const symbolicator = (options: { readonly lookupFails?: boolean } = {}) => {
	const calls: Array<string> = []
	const symbolicateWithOutcome: StackSymbolicatorApi["symbolicateWithOutcome"] = (request) =>
		Effect.sync(() => {
			calls.push(request.stacktrace)
			return {
				stack: symbolicateStack(request.stacktrace, (frame) =>
					frame.url === null || options.lookupFails === true ? undefined : MAPS.get(frame.url),
				),
				lookupFailed: options.lookupFails === true,
			}
		})
	const api: StackSymbolicatorApi = {
		symbolicate: (request) => Effect.map(symbolicateWithOutcome(request), (outcome) => outcome.stack),
		symbolicateWithOutcome,
		hasSourceMaps: () => Effect.succeed(true),
		sourceMapsKnown: () => Effect.succeedSome(true),
	}
	return { api, calls }
}

const sampleRow = (
	hash: string,
	type: string,
	message: string,
	frames: ReadonlyArray<string>,
): GroupingSampleRow => ({
	fingerprintHash: hash,
	serviceName: "web",
	serviceVersion: "",
	timestamp: DateTime.makeUnsafe(1_700_000_000_000),
	traceId: `trace-${hash}`,
	spanId: `span-${hash}`,
	exceptionType: type,
	statusMessage: message,
	exceptionStacktrace: Arr.join([`${type}: ${message}`, ...Arr.map(frames, (f) => `    at ${f}`)], "\n"),
})

const spanRow = (hash: string, fingerprint = ""): GroupingSpanRow => ({
	traceId: `trace-${hash}`,
	spanId: `span-${hash}`,
	spanName: "render",
	spanKind: "Internal",
	spanFingerprint: fingerprint,
	eventsName: '["exception"]',
	eventsAttributes: "[{}]",
})

const MESSAGE = "Cannot read properties of undefined (reading 'total')"

/** Each sample keyed as the tick keys it, with or without a symbolicator. */
const keysOf = (
	samples: ReadonlyArray<GroupingSampleRow>,
	options: {
		readonly stacks?: StackSymbolicatorApi
		readonly fingerprints?: Record<string, string>
		readonly rules?: ReturnType<typeof compileGroupingRules>
	} = {},
) =>
	Arr.map(
		Effect.runSync(
			withSourceMappedStacks(
				Option.fromNullishOr(options.stacks),
				ORG,
				computeSampleInputs(
					samples,
					Arr.map(samples, (s) =>
						spanRow(s.fingerprintHash, options.fingerprints?.[s.fingerprintHash]),
					),
				),
				options.rules,
			),
		),
		(entry) => ({
			key: groupingKey(entry.input, options.rules),
			why: explainGrouping(entry.input, options.rules),
		}),
	)

describe("grouping keys over source maps", () => {
	const v1 = sampleRow("h1", "TypeError", MESSAGE, [V1.app("a")])
	const v2 = sampleRow("h2", "TypeError", MESSAGE, [V2.app("xe")])

	it("joins one bug across two releases that renamed its function and bundle", () => {
		const [rawA, rawB] = keysOf([v1, v2])
		expect(rawA?.key).not.toBe(rawB?.key)
		const { api } = symbolicator()
		const [a, b] = keysOf([v1, v2], { stacks: api })
		expect(a?.key).toBe(b?.key)
		expect(a?.why.rule).toBe("source-mapped")
		// The throw site has no caller to name it, so it keys on its source line's text.
		expect(a?.why.frames).toEqual(["at src/invoice.ts | return invoice.total"])
	})

	it("keeps a different original function apart", () => {
		const cart = sampleRow("h3", "TypeError", MESSAGE, [CART.app("xe")])
		const { api } = symbolicator()
		const [a, c] = keysOf([v1, cart], { stacks: api })
		expect(a?.key).not.toBe(c?.key)
	})

	it("reads past dependency frames to the app's own", () => {
		const viaKy = sampleRow("h4", "TypeError", MESSAGE, [V1.lib("t"), V1.app("a")])
		const viaRetry = sampleRow("h5", "TypeError", MESSAGE, [V2.lib("q"), V2.app("xe")])
		const { api } = symbolicator()
		const [a, b] = keysOf([viaKy, viaRetry], { stacks: api })
		expect(a?.key).toBe(b?.key)
		expect(a?.why.skippedFrames).toHaveLength(1)
		expect(a?.why.skippedFrames[0]).toMatch(/\(node_modules\/ky\/index\.js\)$/)
	})

	it("keys a partly mapped stack on the frames that mapped", () => {
		const withVendor = (bundle: string, r: typeof V1, minified: string, hash: string) =>
			sampleRow(hash, "TypeError", MESSAGE, [
				r.app(minified),
				`Zt (https://app.example.com/assets/${bundle}.js:3:77)`,
			])
		const { api } = symbolicator()
		const [a, b] = keysOf(
			[withVendor("vendor-77", V1, "a", "h6"), withVendor("vendor-9f", V2, "xe", "h7")],
			{
				stacks: api,
			},
		)
		expect(a?.key).toBe(b?.key)
		expect(a?.why.rule).toBe("source-mapped")
	})

	it("leaves custom fingerprints and org merge rules in charge, without a lookup", () => {
		const { api, calls } = symbolicator()
		const [custom] = keysOf([v1], { stacks: api, fingerprints: { h1: "invoice-total" } })
		expect(custom?.why.rule).toBe("custom")
		const rules = compileGroupingRules(
			new GroupingConfig({
				rules: [new OrgGroupingRule({ id: "reads", kind: "merge", message: "*reading*" })],
			}),
		)
		const [merged] = keysOf([v1], { stacks: api, rules })
		expect(merged?.why.rule).toBe("org-rule")
		expect(calls).toEqual([])
	})

	it("keys exactly as before with no symbolicator, no JS frames, or no map", () => {
		const python = sampleRow("h8", "ValueError", "", [])
		const pythonStack = {
			...python,
			exceptionStacktrace: 'Traceback:\n  File "/app/worker.py", line 3, in run\nValueError',
		}
		const unmapped = sampleRow("h9", "TypeError", MESSAGE, [
			"a (https://app.example.com/assets/index-unknown.js:1:1)",
		])
		const { api, calls } = symbolicator()
		const plain = keysOf([pythonStack, unmapped])
		const looked = keysOf([pythonStack, unmapped], { stacks: api })
		expect(Arr.map(looked, (k) => k.key)).toEqual(Arr.map(plain, (k) => k.key))
		expect(calls).toHaveLength(1)
	})
})

describe("keys that wait for a source map", () => {
	const NOW = 1_700_000_000_000
	const unmapped = sampleRow("p1", "TypeError", MESSAGE, [
		"a (https://app.example.com/assets/index-unknown.js:1:1)",
	])
	const mapped = sampleRow("p2", "TypeError", MESSAGE, [V1.app("a")])
	// A vendor chunk: its map loads and every frame maps into `node_modules`.
	const vendor = sampleRow("p3", "TypeError", MESSAGE, [V1.lib("t")])

	/** The hashes keyed by one tick at `NOW`, each hash first seen `firstSeenAgoMs` earlier. */
	const keyedBy = (
		samples: ReadonlyArray<GroupingSampleRow>,
		stacks: StackSymbolicatorApi,
		firstSeenAgoMs: Readonly<Record<string, number>> = {},
	) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const database = yield* Database
				const seen = Rec.toEntries(firstSeenAgoMs)
				if (seen.length > 0) {
					yield* database.execute((db) =>
						db.run(
							PG.insertInto(ErrorFingerprintCandidates).values(
								Arr.map(seen, ([fingerprintHash, ago]) => ({
									orgId: ORG,
									fingerprintHash,
									serviceName: "web",
									exceptionType: "TypeError",
									exceptionMessage: MESSAGE,
									topFrame: "",
									firstSeenAt: NOW - ago,
									lastSeenAt: NOW,
									updatedAt: NOW,
								})),
							),
						),
					)
				}
				yield* resolveGroupingSiblings(
					(run) => database.execute(run),
					{
						samples: () => Effect.succeed(samples),
						spans: (rows) => Effect.succeed(Arr.map(rows, (row) => spanRow(row.fingerprintHash))),
						sourceMapped: (entries, rules) =>
							withSourceMappedStacks(Option.some(stacks), ORG, entries, rules),
					},
					{
						orgId: ORG,
						hashes: Arr.map(samples, (sample) => sample.fingerprintHash),
						nowMs: NOW,
						grouping: DEFAULT_ORG_GROUPING,
						lineage: new Map(),
					},
				)
				const rows = yield* database.execute((db) =>
					db.run(
						PG.from(ErrorGroupingKeys)
							.select("fingerprintHash")
							.where(($) => [$.orgId.eq(ORG)]),
					),
				)
				return Arr.sort(
					Arr.map(rows, (row) => row.fingerprintHash),
					Order.String,
				)
			}).pipe(Effect.provide(createTestDb(createdDbs).layer)),
		)

	it("holds a first sighting whose frames found no map, and keys a mapped one", async () => {
		const { api } = symbolicator()
		expect(await keyedBy([unmapped, mapped], api)).toEqual(["p2"])
	})

	it("keys a vendor chunk that mapped into dependencies at once", async () => {
		const { api } = symbolicator()
		expect(await keyedBy([vendor], api)).toEqual(["p3"])
	})

	it("holds a hash whose lookup failed while it is young", async () => {
		const { api } = symbolicator({ lookupFails: true })
		expect(
			await keyedBy([unmapped, mapped], api, { p1: MAP_PENDING_GRACE_MS - 60_000, p2: 5 * 60_000 }),
		).toEqual([])
	})

	it("keys on raw frames once the hash was first seen over the window ago, however fresh its sample", async () => {
		const { api } = symbolicator({ lookupFails: true })
		expect(
			await keyedBy([unmapped, mapped], api, {
				p1: MAP_PENDING_GRACE_MS,
				p2: 3 * MAP_PENDING_GRACE_MS,
			}),
		).toEqual(["p1", "p2"])
	})

	/** A stored mapped key for `p2`, under rules since changed, after one tick re-keys it from `sample`. */
	const storedAfterRekey = (api: StackSymbolicatorApi, sample: GroupingSampleRow) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const database = yield* Database
				// First seen long ago, keyed on mapped frames under rules since changed: the tick re-keys it.
				yield* database.execute((db) =>
					db.run(
						PG.insertInto(ErrorFingerprintCandidates).values({
							orgId: ORG,
							fingerprintHash: "p2",
							serviceName: "web",
							exceptionType: "TypeError",
							exceptionMessage: MESSAGE,
							topFrame: "",
							firstSeenAt: NOW - 3 * MAP_PENDING_GRACE_MS,
							lastSeenAt: NOW,
							updatedAt: NOW,
						}),
					),
				)
				yield* database.execute((db) =>
					db.run(
						PG.insertInto(ErrorGroupingKeys).values({
							orgId: ORG,
							fingerprintHash: "p2",
							groupingKey: "mapped-key",
							keyVersion: 1,
							configDigest: "rules-before",
							rule: "source-mapped",
							pinned: false,
							createdAt: 0,
							updatedAt: 0,
						}),
					),
				)
				yield* resolveGroupingSiblings(
					(run) => database.execute(run),
					{
						samples: () => Effect.succeed([{ ...sample, fingerprintHash: "p2" }]),
						spans: (rows) => Effect.succeed(Arr.map(rows, (row) => spanRow(row.fingerprintHash))),
						sourceMapped: (entries, rules) =>
							withSourceMappedStacks(Option.some(api), ORG, entries, rules),
					},
					{
						orgId: ORG,
						hashes: ["p2"],
						nowMs: NOW,
						grouping: DEFAULT_ORG_GROUPING,
						lineage: new Map(),
					},
				)
				return yield* database.execute((db) =>
					db.run(
						PG.from(ErrorGroupingKeys)
							.select("groupingKey", "configDigest")
							.where(($) => [$.orgId.eq(ORG)]),
					),
				)
			}).pipe(Effect.provide(createTestDb(createdDbs).layer)),
		)

	it("keeps a stored key whose re-key lookup failed, however old the hash", async () => {
		const { api } = symbolicator({ lookupFails: true })
		expect(await storedAfterRekey(api, mapped)).toEqual([
			{ groupingKey: "mapped-key", configDigest: "rules-before" },
		])
	})

	it("keeps a stored key when the stack maps but gives nothing to key on", async () => {
		const { api } = symbolicator()
		const bare = sampleRow("p2", "TypeError", MESSAGE, [BARE.app("a")])
		expect(await storedAfterRekey(api, bare)).toEqual([
			{ groupingKey: "mapped-key", configDigest: "rules-before" },
		])
	})

	it("keeps a stored key whose map is pending instead of re-keying it on minified frames", async () => {
		const { api } = symbolicator()
		expect(await storedAfterRekey(api, unmapped)).toEqual([
			{ groupingKey: "mapped-key", configDigest: "rules-before" },
		])
		// A sample that maps does re-key.
		expect(await storedAfterRekey(api, mapped)).not.toEqual([
			{ groupingKey: "mapped-key", configDigest: "rules-before" },
		])
	})

	it("holds a first sighting whose throw site did not map, even when its app caller did", async () => {
		const throwSite = (hash: string, bundle: string) =>
			sampleRow(hash, "TypeError", MESSAGE, [
				`t (https://app.example.com/assets/${bundle}.js:1:1)`,
				V1.app("a"),
			])
		const { api } = symbolicator()
		expect(
			await keyedBy([throwSite("p5", "index-one"), throwSite("p6", "index-two"), mapped], api),
		).toEqual(["p2"])
	})

	it("holds a first sighting whose app frames did not map, even when a dependency frame did", async () => {
		const mixed = sampleRow("p4", "TypeError", MESSAGE, [
			"a (https://app.example.com/assets/index-unknown.js:1:1)",
			V1.lib("t"),
		])
		const { api } = symbolicator()
		expect(await keyedBy([mixed, vendor], api)).toEqual(["p3"])
	})

	it("reads first sightings only past the per-tick cap", async () => {
		const statementsFor = (count: number) =>
			Effect.runPromise(
				Effect.gen(function* () {
					const database = yield* Database
					const runs = { count: 0 }
					yield* resolveGroupingSiblings(
						(run) =>
							Effect.suspend(() => {
								runs.count += 1
								return database.execute(run)
							}),
						{
							samples: () => Effect.succeed([]),
							spans: () => Effect.succeed([]),
							sourceMapped: (entries) => Effect.succeed(entries),
							mapsInPlay: Effect.succeedSome(false),
						},
						{
							orgId: ORG,
							hashes: Arr.makeBy(count, (i) => `n${i}`),
							nowMs: NOW,
							grouping: DEFAULT_ORG_GROUPING,
							lineage: new Map(),
						},
					)
					return runs.count
				}).pipe(Effect.provide(createTestDb(createdDbs).layer)),
			)
		// The stored-key read; past the cap, one first-sighting read more to order the hashes.
		expect(await statementsFor(200)).toBe(1)
		expect(await statementsFor(201)).toBe(2)
	})
})

describe("an org's first source map upload", () => {
	const NOW = 1_700_000_000_000
	const DEBUG_ID = "6c5e2b1a-1f2e-4d3c-8b7a-0123456789ab"
	const v1 = sampleRow("f1", "TypeError", MESSAGE, [V1.app("a")])
	const v2 = sampleRow("f2", "TypeError", MESSAGE, [V2.app("xe")])

	/** One tick over `samples`, with or without maps; spans carry the debug ids given per hash. */
	const tick = (
		database: (typeof Database)["Service"],
		samples: ReadonlyArray<GroupingSampleRow>,
		hasMaps: Option.Option<boolean>,
		debugIds: Readonly<Record<string, Record<string, string>>> = {},
		nowMs: number = NOW,
	) => {
		const { api } = symbolicator()
		const stacks: StackSymbolicatorApi = {
			...api,
			hasSourceMaps: () => Effect.succeed(Option.getOrElse(hasMaps, () => true)),
			sourceMapsKnown: () => Effect.succeed(hasMaps),
		}
		return resolveGroupingSiblings(
			(run) => database.execute(run),
			{
				samples: (hashes) =>
					Effect.succeed(Arr.filter(samples, (s) => Arr.contains(hashes, s.fingerprintHash))),
				spans: (rows) =>
					Effect.succeed(
						Arr.map(rows, (row) => {
							const ids = debugIds[row.fingerprintHash]
							return ids === undefined
								? spanRow(row.fingerprintHash)
								: {
										...spanRow(row.fingerprintHash),
										eventsAttributes: JSON.stringify([
											{ "maple.exception.debug_ids": JSON.stringify(ids) },
										]),
									}
						}),
					),
				sourceMapped: (entries, rules) =>
					withSourceMappedStacks(Option.some(stacks), ORG, entries, rules),
				mapsInPlay: stacks.sourceMapsKnown(ORG),
			},
			{
				orgId: ORG,
				hashes: Arr.map(samples, (sample) => sample.fingerprintHash),
				nowMs,
				grouping: DEFAULT_ORG_GROUPING,
				lineage: new Map(),
			},
		)
	}

	const storedKeys = (database: (typeof Database)["Service"]) =>
		database.execute((db) =>
			db.run(
				PG.from(ErrorGroupingKeys)
					.select("fingerprintHash", "groupingKey", "configDigest")
					.where(($) => [$.orgId.eq(ORG)])
					.orderBy(($) => [[$.fingerprintHash, "asc"]]),
			),
		)

	it("re-keys a raw key once maps exist, so the next release joins it", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const database = yield* Database
				yield* tick(database, [v1], Option.some(false))
				const before = yield* storedKeys(database)
				// The org uploads its first maps; v1 recurs and the next release throws.
				const siblings = yield* tick(database, [v1, v2], Option.some(true))
				return { before, after: yield* storedKeys(database), siblings }
			}).pipe(Effect.provide(createTestDb(createdDbs).layer)),
		)
		expect(result.before).toEqual([
			{ fingerprintHash: "f1", groupingKey: keysOf([v1])[0]?.key, configDigest: "" },
		])
		const mappedKey = keysOf([v1], { stacks: symbolicator().api })[0]?.key
		expect(result.after).toEqual([
			{ fingerprintHash: "f1", groupingKey: mappedKey, configDigest: "+source-maps" },
			{ fingerprintHash: "f2", groupingKey: mappedKey, configDigest: "+source-maps" },
		])
		expect(result.siblings.get("f2")).toEqual(["f1"])
	})

	it("keeps an org without maps on today's digest", async () => {
		const keys = await Effect.runPromise(
			Effect.gen(function* () {
				const database = yield* Database
				yield* tick(database, [v1], Option.some(false))
				yield* tick(database, [v1], Option.some(false))
				return yield* storedKeys(database)
			}).pipe(Effect.provide(createTestDb(createdDbs).layer)),
		)
		expect(Arr.map(keys, (row) => row.configDigest)).toEqual([""])
	})

	it("re-keys nothing when the has-maps lookup fails", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const database = yield* Database
				// f1 keyed before the org had maps, f2 after: neither moves on a failed lookup.
				yield* tick(database, [v1], Option.some(false))
				yield* tick(database, [v2], Option.some(true))
				const before = yield* storedKeys(database)
				yield* tick(database, [v1, v2], Option.none())
				return { before, after: yield* storedKeys(database) }
			}).pipe(Effect.provide(createTestDb(createdDbs).layer)),
		)
		expect(Arr.map(result.before, (row) => row.configDigest)).toEqual(["", "+source-maps"])
		expect(result.after).toEqual(result.before)
	})

	const seedSeen = (
		database: (typeof Database)["Service"],
		seen: ReadonlyArray<readonly [string, number]>,
	) =>
		database.execute((db) =>
			db.run(
				PG.insertInto(ErrorFingerprintCandidates).values(
					Arr.map(seen, ([fingerprintHash, firstSeenAt]) => ({
						orgId: ORG,
						fingerprintHash,
						serviceName: "web",
						exceptionType: "TypeError",
						exceptionMessage: MESSAGE,
						topFrame: "",
						firstSeenAt,
						lastSeenAt: NOW,
						updatedAt: NOW,
					})),
				),
			),
		)

	it("lets a ready hash past 200 held for a first map in a mapless org within two ticks", async () => {
		const held = Arr.makeBy(200, (i) =>
			sampleRow(`w${Str.padStart(3, "0")(String(i))}`, "TypeError", MESSAGE, [V1.app("a")]),
		)
		const ready = sampleRow("zz-ready", "TypeError", MESSAGE, [V1.app("a")])
		const ids = Rec.fromEntries(
			Arr.map(held, (row) => [row.fingerprintHash, { [V1.url]: DEBUG_ID }] as const),
		)
		const keyed = await Effect.runPromise(
			Effect.gen(function* () {
				const database = yield* Database
				yield* seedSeen(
					database,
					Arr.map([...held, ready], (row) => [row.fingerprintHash, NOW - 5 * 60_000] as const),
				)
				yield* tick(database, [...held, ready], Option.some(false), ids)
				yield* tick(database, [...held, ready], Option.some(false), ids, NOW + 60_000)
				return Arr.map(yield* storedKeys(database), (row) => row.fingerprintHash)
			}).pipe(Effect.provide(createTestDb(createdDbs).layer)),
		)
		expect(keyed).toEqual(["zz-ready"])
	})

	it("keeps expired hashes that never find a span from taking every slot", async () => {
		const noSpan = Arr.makeBy(200, (i) => `y${Str.padStart(3, "0")(String(i))}`)
		const fresh = sampleRow("new-one", "TypeError", MESSAGE, [V1.app("a")])
		const keyed = await Effect.runPromise(
			Effect.gen(function* () {
				const database = yield* Database
				yield* seedSeen(
					database,
					Arr.map(noSpan, (hash) => [hash, NOW - 2 * MAP_PENDING_GRACE_MS] as const),
				)
				// Only `new-one` has a sample and span; the 200 old hashes come back with nothing.
				yield* resolveGroupingSiblings(
					(run) => database.execute(run),
					{
						samples: (hashes) =>
							Effect.succeed(
								Arr.filter([fresh], (s) => Arr.contains(hashes, s.fingerprintHash)),
							),
						spans: (rows) => Effect.succeed(Arr.map(rows, (row) => spanRow(row.fingerprintHash))),
						mapsInPlay: Effect.succeedSome(false),
					},
					{
						orgId: ORG,
						hashes: [...noSpan, "new-one"],
						nowMs: NOW,
						grouping: DEFAULT_ORG_GROUPING,
						lineage: new Map(),
					},
				)
				return Arr.map(yield* storedKeys(database), (row) => row.fingerprintHash)
			}).pipe(Effect.provide(createTestDb(createdDbs).layer)),
		)
		expect(keyed).toEqual(["new-one"])
	})

	it("keys a hash held past its grace window even behind 200 first sightings", async () => {
		const fresh = Arr.makeBy(200, (i) =>
			sampleRow(`x${Str.padStart(3, "0")(String(i))}`, "TypeError", MESSAGE, [V1.app("a")]),
		)
		const expired = sampleRow("old", "TypeError", MESSAGE, [
			"a (https://app.example.com/assets/index-unknown.js:1:1)",
		])
		const keyed = await Effect.runPromise(
			Effect.gen(function* () {
				const database = yield* Database
				yield* seedSeen(database, [["old", NOW - MAP_PENDING_GRACE_MS]])
				yield* tick(database, [...fresh, expired], Option.some(true))
				return Arr.map(yield* storedKeys(database), (row) => row.fingerprintHash)
			}).pipe(Effect.provide(createTestDb(createdDbs).layer)),
		)
		expect(keyed).toContain("old")
	})

	it("keeps a raw key stored past the grace window when its map comes later (known limit)", async () => {
		// The release's map arrives only after the hash keyed on raw frames: the stored key stays.
		const late = sampleRow("late", "TypeError", MESSAGE, [
			"a (https://app.example.com/assets/index-late.js:1:1)",
		])
		const phase = { mapped: false }
		const lateStacks: StackSymbolicatorApi = {
			...symbolicator().api,
			symbolicateWithOutcome: (request) =>
				Effect.sync(() => ({
					stack: symbolicateStack(request.stacktrace, () => (phase.mapped ? V1.map : undefined)),
					lookupFailed: false,
				})),
		}
		const keys = await Effect.runPromise(
			Effect.gen(function* () {
				const database = yield* Database
				yield* seedSeen(database, [["late", NOW - MAP_PENDING_GRACE_MS]])
				const once = () =>
					resolveGroupingSiblings(
						(run) => database.execute(run),
						{
							samples: () => Effect.succeed([late]),
							spans: (rows) =>
								Effect.succeed(Arr.map(rows, (row) => spanRow(row.fingerprintHash))),
							sourceMapped: (entries, rules) =>
								withSourceMappedStacks(Option.some(lateStacks), ORG, entries, rules),
							mapsInPlay: Effect.succeedSome(true),
						},
						{
							orgId: ORG,
							hashes: ["late"],
							nowMs: NOW,
							grouping: DEFAULT_ORG_GROUPING,
							lineage: new Map(),
						},
					)
				yield* once()
				const before = yield* storedKeys(database)
				phase.mapped = true
				yield* once()
				return { before, after: yield* storedKeys(database) }
			}).pipe(Effect.provide(createTestDb(createdDbs).layer)),
		)
		expect(keys.before).toHaveLength(1)
		expect(keys.after).toEqual(keys.before)
	})

	it("holds a young sample that registered debug ids before the org has any map", async () => {
		const ids = { f1: { [V1.url]: DEBUG_ID } }
		const keyed = (firstSeenAgo: number) =>
			Effect.runPromise(
				Effect.gen(function* () {
					const database = yield* Database
					yield* database.execute((db) =>
						db.run(
							PG.insertInto(ErrorFingerprintCandidates).values({
								orgId: ORG,
								fingerprintHash: "f1",
								serviceName: "web",
								exceptionType: "TypeError",
								exceptionMessage: MESSAGE,
								topFrame: "",
								firstSeenAt: NOW - firstSeenAgo,
								lastSeenAt: NOW,
								updatedAt: NOW,
							}),
						),
					)
					yield* tick(database, [v1, v2], Option.some(false), ids)
					return Arr.map(yield* storedKeys(database), (row) => row.fingerprintHash)
				}).pipe(Effect.provide(createTestDb(createdDbs).layer)),
			)
		// f2 carries no debug ids: nothing says a map is coming, so it keys at once.
		expect(await keyed(5 * 60_000)).toEqual(["f2"])
		expect(await keyed(MAP_PENDING_GRACE_MS)).toEqual(["f1", "f2"])
	})
})
