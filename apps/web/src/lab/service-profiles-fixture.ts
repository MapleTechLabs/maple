import { Array as Arr } from "effect"
import type { ServiceProfile } from "../page/services/detail/model"

// `/lab/service-profiles`: one hour of CPU profiles from `checkout-api`, a small Node service, written
// by hand. Stacks are root first; own code lives under `/app/src`, the rest is libraries and runtime.

/** 2026-11-15T12:00:00Z. */
export const PROFILES_NOW = 1_794_744_000_000
export const PROFILES_SERVICE = "checkout-api"

type Frame = readonly [name: string, file: string, line: number]

const SRC = "/app/src"
const MODULES = "/app/node_modules"

// The runtime and library frames every request stack starts under.
const TICK: Frame = ["processTicksAndRejections", "node:internal/process/task_queues", 95]
const FIBER: Frame = ["runLoop", `${MODULES}/effect/dist/internal/fiberRuntime.js`, 1384]
const EVALUATE: Frame = ["evaluateEffect", `${MODULES}/effect/dist/internal/fiberRuntime.js`, 1012]
const ROUTER: Frame = ["handleRequest", `${MODULES}/@effect/platform/dist/HttpRouter.js`, 214]
const REQUEST: ReadonlyArray<Frame> = [TICK, FIBER, EVALUATE, ROUTER]

// Own code.
const SEARCH: Frame = ["searchCatalog", `${SRC}/routes/search.ts`, 41]
const RANK: Frame = ["rankMatches", `${SRC}/catalog/rank.ts`, 18]
const LEVENSHTEIN: Frame = ["levenshtein", `${SRC}/catalog/distance.ts`, 7]
const NORMALIZE: Frame = ["normalizeQuery", `${SRC}/catalog/normalize.ts`, 12]
const CHECKOUT: Frame = ["submitCheckout", `${SRC}/routes/checkout.ts`, 63]
const PRICE: Frame = ["priceCart", `${SRC}/pricing/cart.ts`, 29]
const TAX: Frame = ["taxForLine", `${SRC}/pricing/tax.ts`, 44]
const DISCOUNT: Frame = ["applyDiscounts", `${SRC}/pricing/discounts.ts`, 22]
const SIGN: Frame = ["signReceipt", `${SRC}/receipts/sign.ts`, 15]
const RENDER: Frame = ["renderReceipt", `${SRC}/receipts/render.ts`, 31]
const INVENTORY: Frame = ["reserveInventory", `${SRC}/inventory/reserve.ts`, 52]
const ORDERS: Frame = ["listOrders", `${SRC}/routes/orders.ts`, 27]
const SERIALIZE: Frame = ["serializeOrder", `${SRC}/orders/serialize.ts`, 9]

// Libraries and runtime.
const SORT: Frame = ["sort", "", 0]
const JSON_STRINGIFY: Frame = ["stringify", "", 0]
const JSON_PARSE: Frame = ["parse", "", 0]
const HASH_UPDATE: Frame = ["update", "node:internal/crypto/hash", 115]
const HASH_DIGEST: Frame = ["digest", "node:internal/crypto/hash", 140]
const PG_QUERY: Frame = ["query", `${MODULES}/pg/lib/client.js`, 526]
const PG_PARSE: Frame = ["parseRow", `${MODULES}/pg/lib/result.js`, 62]
const PG_TYPES: Frame = ["parseTimestamp", `${MODULES}/pg-types/lib/textParsers.js`, 88]
const SCHEMA_DECODE: Frame = ["decodeUnknown", `${MODULES}/effect/dist/internal/schema/parser.js`, 301]
const SCHEMA_STRUCT: Frame = ["parseStruct", `${MODULES}/effect/dist/internal/schema/parser.js`, 644]
const OTEL_EXPORT: Frame = ["export", `${MODULES}/@maple-dev/effect-sdk/dist/server/exporter.js`, 73]
const GZIP: Frame = ["gzipSync", "node:zlib", 812]
const SOCKET_WRITE: Frame = ["writeGeneric", "node:internal/stream_base_commons", 147]
const TIMERS: Frame = ["processTimers", "node:internal/timers", 512]
const GC: Frame = ["(garbage collector)", "", 0]
const IDLE: Frame = ["(program)", "", 0]

const MS = 1_000_000

const stack = (frames: ReadonlyArray<Frame>, ms: number) => ({
	frames: Arr.map(frames, ([name]) => name),
	files: Arr.map(frames, ([, file]) => file),
	lines: Arr.map(frames, ([, , line]) => line),
	value: ms * MS,
})

const request = (frames: ReadonlyArray<Frame>, ms: number) => stack([...REQUEST, ...frames], ms)

const STACKS = [
	// Search: the quadratic distance function is the hot spot.
	request([SEARCH, RANK, LEVENSHTEIN], 41_820),
	request([SEARCH, RANK, SORT], 6_140),
	request([SEARCH, RANK], 2_310),
	request([SEARCH, NORMALIZE], 1_480),
	request([SEARCH, SCHEMA_DECODE, SCHEMA_STRUCT], 1_120),
	request([SEARCH, JSON_STRINGIFY], 2_960),
	request([SEARCH], 640),
	// Checkout: pricing, the receipt and the inventory write.
	request([CHECKOUT, PRICE, TAX], 9_370),
	request([CHECKOUT, PRICE, DISCOUNT], 4_210),
	request([CHECKOUT, PRICE], 1_050),
	request([CHECKOUT, SIGN, HASH_UPDATE], 7_680),
	request([CHECKOUT, SIGN, HASH_DIGEST], 1_940),
	request([CHECKOUT, RENDER, JSON_STRINGIFY], 3_150),
	request([CHECKOUT, RENDER], 890),
	request([CHECKOUT, INVENTORY, PG_QUERY, SOCKET_WRITE], 1_260),
	request([CHECKOUT, INVENTORY, PG_QUERY, PG_PARSE], 2_030),
	request([CHECKOUT, SCHEMA_DECODE, SCHEMA_STRUCT], 1_710),
	request([CHECKOUT, JSON_PARSE], 980),
	request([CHECKOUT], 420),
	// Orders: mostly reading rows and writing them back out.
	request([ORDERS, PG_QUERY, PG_PARSE, PG_TYPES], 5_480),
	request([ORDERS, PG_QUERY, PG_PARSE], 2_640),
	request([ORDERS, SERIALIZE, JSON_STRINGIFY], 3_870),
	request([ORDERS, SERIALIZE], 1_190),
	request([ORDERS], 310),
	// The effect runtime's own overhead between handlers.
	stack([TICK, FIBER, EVALUATE], 3_260),
	stack([TICK, FIBER], 1_540),
	// Telemetry export, off the request path.
	stack([TIMERS, OTEL_EXPORT, JSON_STRINGIFY], 2_180),
	stack([TIMERS, OTEL_EXPORT, GZIP], 3_420),
	stack([TIMERS, OTEL_EXPORT, SOCKET_WRITE], 760),
	// No JavaScript frame.
	stack([GC], 4_930),
	stack([IDLE], 1_870),
]

const totalValue = Arr.reduce(STACKS, 0, (sum, row) => sum + row.value)

/** 31 stacks, about two minutes of CPU over a profiled hour: 0.03 cores on average. */
export const PROFILES_PROFILE: NonNullable<ServiceProfile> = {
	sampleType: "cpu",
	sampleUnit: "nanoseconds",
	totalValue,
	totalStacks: STACKS.length,
	durationNano: 3600 * 1000 * MS,
	truncated: false,
	stacks: STACKS,
}
