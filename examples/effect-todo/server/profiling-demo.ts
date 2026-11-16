#!/usr/bin/env bun
/**
 * A CPU-bound workload for trying continuous profiling against Maple local mode.
 *
 * It stands in for a small checkout API: a few request kinds, each a server span with child
 * spans, each child doing real work in a function with a recognisable name. Requests overlap, so
 * the profile has to tell concurrent spans apart to attribute a sample to the right one.
 *
 *   maple start                      # or: bun run apps/cli/src/bin.ts start
 *   bun run server/profiling-demo.ts # sends traces and CPU profiles for DURATION_SECONDS
 */
import { createHash } from "node:crypto"
import { Maple } from "@maple-dev/effect-sdk/server"
import { Duration, Effect, Random, Schedule, Schema } from "effect"

const DURATION_SECONDS = Number(process.env.DURATION_SECONDS ?? 40)
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4)

const telemetry = Maple.layer({
	serviceName: process.env.SERVICE_NAME ?? "checkout-api",
	serviceVersion: process.env.SERVICE_VERSION ?? "1.4.0",
	serviceNamespace: "examples",
	environment: "development",
	endpoint: process.env.MAPLE_ENDPOINT ?? "http://127.0.0.1:4318",
	tracerExportInterval: "2 seconds",
	profiling: { window: "5 seconds", samplingIntervalMicros: 1000 },
})

const CATALOG = Array.from({ length: 4000 }, (_, index) => ({
	sku: `SKU-${index}`,
	name: `${["oak", "maple", "birch", "walnut", "cedar"][index % 5]} ${["desk", "shelf", "chair", "table"][index % 4]} ${index}`,
	priceCents: 1500 + ((index * 7919) % 90_000),
}))

// --- the work: plain functions, so their names are what the flame graph shows ---

/** Deliberately quadratic: the hot spot a profile should point straight at. */
function levenshtein(a: string, b: string): number {
	const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
	for (let row = 1; row <= a.length; row++) {
		let diagonal = previous[0] ?? 0
		previous[0] = row
		for (let column = 1; column <= b.length; column++) {
			const above = previous[column] ?? 0
			const cost = a.charCodeAt(row - 1) === b.charCodeAt(column - 1) ? 0 : 1
			previous[column] = Math.min(above + 1, (previous[column - 1] ?? 0) + 1, diagonal + cost)
			diagonal = above
		}
	}
	return previous[b.length] ?? 0
}

function rankCatalog(query: string) {
	return CATALOG.map((item) => ({ item, distance: levenshtein(query, item.name) }))
		.sort((left, right) => left.distance - right.distance)
		.slice(0, 20)
}

function serializeResults(results: ReturnType<typeof rankCatalog>): string {
	return JSON.stringify(
		results.map(({ item, distance }) => ({ ...item, distance, tags: item.name.split(" ") })),
	)
}

function priceCart(lines: ReadonlyArray<{ sku: string; quantity: number }>): number {
	let total = 0
	for (const line of lines) {
		const item = CATALOG.find((each) => each.sku === line.sku)
		if (item === undefined) continue
		const discount = line.quantity >= 3 ? 0.9 : 1
		total += Math.round(item.priceCents * line.quantity * discount)
	}
	return total
}

function renderReceipt(lines: ReadonlyArray<{ sku: string; quantity: number }>, totalCents: number): string {
	const rows = lines.map((line) => `${line.sku.padEnd(12)} x${String(line.quantity).padStart(3)}`)
	return [...rows, "-".repeat(24), `TOTAL ${(totalCents / 100).toFixed(2)}`].join("\n").repeat(40)
}

function signReceipt(receipt: string): string {
	let digest = receipt
	for (let round = 0; round < 60; round++) digest = createHash("sha256").update(digest).digest("hex")
	return digest
}

function buildSalesReport(): string {
	const byWood = new Map<string, number>()
	for (const item of CATALOG) {
		const wood = /^(\w+) /.exec(item.name)?.[1] ?? "other"
		byWood.set(wood, (byWood.get(wood) ?? 0) + item.priceCents)
	}
	return [...byWood].map(([wood, cents]) => `${wood},${cents}`).join("\n")
}

const decodeImport = Schema.decodeUnknownSync(
	Schema.Array(Schema.Struct({ sku: Schema.String, name: Schema.String, priceCents: Schema.Number })),
)

function parseImport(payload: string) {
	return decodeImport(JSON.parse(payload))
}

/** Near-duplicate names collapse into one: quadratic on purpose, the slow part of an import. */
function dedupeByName(items: ReadonlyArray<{ sku: string; name: string; priceCents: number }>) {
	const kept: Array<{ sku: string; name: string; priceCents: number }> = []
	for (const item of items) {
		if (!kept.some((other) => levenshtein(other.name, item.name) <= 1)) kept.push(item)
	}
	return kept
}

function buildSearchIndex(items: ReadonlyArray<{ sku: string; name: string }>): Map<string, Array<string>> {
	const index = new Map<string, Array<string>>()
	for (const item of items) {
		for (const token of item.name.toLowerCase().split(" ")) {
			const skus = index.get(token) ?? []
			skus.push(item.sku)
			index.set(token, skus)
		}
	}
	return new Map([...index].sort(([left], [right]) => left.localeCompare(right)))
}

const IMPORT_PAYLOAD = JSON.stringify(CATALOG.slice(0, 700))

// --- the requests: each step is a span, so a span's own profile can be read ---

const search = Effect.fn("GET /search", { kind: "server", attributes: { "http.route": "/search" } })(
	function* (query: string) {
		const ranked = yield* Effect.sync(() => rankCatalog(query)).pipe(Effect.withSpan("search.rank"))
		// A yield between the two steps: another request's span runs here in the meantime.
		yield* Effect.yieldNow
		return yield* Effect.sync(() => serializeResults(ranked)).pipe(Effect.withSpan("search.serialize"))
	},
)

const checkout = Effect.fn("POST /checkout", { kind: "server", attributes: { "http.route": "/checkout" } })(
	function* (lines: ReadonlyArray<{ sku: string; quantity: number }>) {
		const total = yield* Effect.sync(() => priceCart(lines)).pipe(Effect.withSpan("cart.price"))
		yield* Effect.sleep("3 millis").pipe(Effect.withSpan("inventory.reserve", { kind: "client" }))
		const receipt = yield* Effect.sync(() => renderReceipt(lines, total)).pipe(
			Effect.withSpan("receipt.render"),
		)
		return yield* Effect.sync(() => signReceipt(receipt)).pipe(Effect.withSpan("receipt.sign"))
	},
)

/** The slow endpoint: one request is long enough that its own profile says where it went. */
const importCatalog = Effect.gen(function* () {
	const items = yield* Effect.sync(() => parseImport(IMPORT_PAYLOAD)).pipe(Effect.withSpan("import.parse"))
	yield* Effect.yieldNow
	const unique = yield* Effect.sync(() => dedupeByName(items)).pipe(Effect.withSpan("import.dedupe"))
	yield* Effect.yieldNow
	return yield* Effect.sync(() => buildSearchIndex(unique)).pipe(Effect.withSpan("import.index"))
}).pipe(
	Effect.withSpan("POST /catalog/import", {
		kind: "server",
		attributes: { "http.route": "/catalog/import" },
	}),
)

const report = Effect.sync(buildSalesReport).pipe(
	Effect.withSpan("report.build"),
	Effect.withSpan("GET /reports/sales", { kind: "server", attributes: { "http.route": "/reports/sales" } }),
)

const QUERIES = ["maple desk", "walnut chair 12", "oak shelf", "cedar table 7", "birch"]

const request = Effect.gen(function* () {
	const roll = yield* Random.nextIntBetween(0, 10)
	if (roll < 3) {
		const query = QUERIES[yield* Random.nextIntBetween(0, QUERIES.length)] ?? "maple desk"
		return yield* search(query)
	}
	if (roll < 9) {
		const lines = yield* Effect.forEach([0, 1, 2, 3, 4, 5], () =>
			Effect.map(Random.nextIntBetween(0, CATALOG.length), (index) => ({
				sku: `SKU-${index}`,
				quantity: 1 + (index % 4),
			})),
		)
		return yield* checkout(lines)
	}
	return yield* report
})

// One client per lane: a request, then a short think time, until the run is over.
const client = request.pipe(
	Effect.andThen(Effect.sleep("15 millis")),
	Effect.repeat(Schedule.spaced("5 millis")),
)

// An occasional import alongside the steady traffic.
const importer = importCatalog.pipe(Effect.repeat(Schedule.spaced("4 seconds")))

const program = Effect.gen(function* () {
	yield* Effect.log(`profiling demo: ${CONCURRENCY} clients for ${DURATION_SECONDS}s`)
	yield* Effect.all(
		[
			importer,
			Effect.forEach(Array.from({ length: CONCURRENCY }), () => client, {
				concurrency: "unbounded",
				discard: true,
			}),
		],
		{ concurrency: "unbounded", discard: true },
	).pipe(Effect.timeout(Duration.seconds(DURATION_SECONDS)), Effect.ignore)
	yield* Effect.log("profiling demo: done, flushing")
})

Effect.runPromise(program.pipe(Effect.provide(telemetry))).then(
	() => process.exit(0),
	(error: unknown) => {
		console.error(error)
		process.exit(1)
	},
)
