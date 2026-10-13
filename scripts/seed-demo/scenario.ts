/**
 * Acme Shop: the one world every landing screenshot is taken in.
 *
 * Nine services on Kubernetes, 24h of traffic on a daily curve, a handful of
 * routine deploys, and one bad one: payment-svc 3.5.0 lands `incidentOffsetMs`
 * before the anchor, exhausts its Postgres pool, and starts timing out charges.
 */
import type { Rng } from "./rng"

export type Language = "nodejs" | "go" | "python"

export type ServiceName =
	| "storefront"
	| "checkout-api"
	| "cart-svc"
	| "catalog-api"
	| "inventory-svc"
	| "payment-svc"
	| "auth-svc"
	| "order-worker"
	| "notification-svc"

export interface ServiceDef {
	readonly name: ServiceName
	readonly language: Language
	readonly baseVersion: string
	/** Pods per rollout; each span lands on one of them. */
	readonly replicas: number
}

export const SERVICES: ReadonlyArray<ServiceDef> = [
	{ name: "storefront", language: "nodejs", baseVersion: "5.8.2", replicas: 4 },
	{ name: "checkout-api", language: "nodejs", baseVersion: "4.2.0", replicas: 3 },
	{ name: "cart-svc", language: "go", baseVersion: "1.22.1", replicas: 2 },
	{ name: "catalog-api", language: "python", baseVersion: "2.14.0", replicas: 3 },
	{ name: "inventory-svc", language: "go", baseVersion: "3.1.4", replicas: 2 },
	{ name: "payment-svc", language: "nodejs", baseVersion: "3.4.1", replicas: 2 },
	{ name: "auth-svc", language: "go", baseVersion: "2.0.3", replicas: 2 },
	{ name: "order-worker", language: "nodejs", baseVersion: "1.9.0", replicas: 2 },
	{ name: "notification-svc", language: "python", baseVersion: "0.12.5", replicas: 1 },
]

export interface DeployDef {
	readonly service: ServiceName
	readonly version: string
	/** Milliseconds before the anchor. */
	readonly beforeAnchorMs: number
}

const HOUR = 3_600_000
const MINUTE = 60_000

export const DEPLOYS: ReadonlyArray<DeployDef> = [
	{ service: "catalog-api", version: "2.15.0", beforeAnchorMs: 19 * HOUR },
	{ service: "storefront", version: "5.9.0", beforeAnchorMs: 10 * HOUR },
	{ service: "cart-svc", version: "1.23.0", beforeAnchorMs: 5 * HOUR + 30 * MINUTE },
	{ service: "payment-svc", version: "3.5.0", beforeAnchorMs: 2 * HOUR },
]

export const INCIDENT = {
	service: "payment-svc",
	version: "3.5.0",
	poolSize: 20,
} as const satisfies { readonly service: ServiceName; readonly version: string; readonly poolSize: number }

/** What an op can see about the moment its trace runs in. */
export interface Ctx {
	readonly at: number
	/** True once the bad payment-svc deploy is live. */
	readonly incident: boolean
	readonly rng: Rng
}

export interface Failure {
	readonly type: string
	readonly message: string
	readonly stacktrace: string
	/** Log line lead-in, e.g. "charge failed"; defaults to the exception type. */
	readonly logPrefix?: string
	/** The span runs this long when it fails (a timeout ends at the timeout). */
	readonly durationMs?: number
}

type Latency = (ctx: Ctx) => readonly [median: number, spread: number]
type FailRule = (ctx: Ctx) => Failure | null

export type Op =
	| {
			readonly kind: "server"
			readonly service: ServiceName
			readonly method: string
			readonly route: string
			readonly self: Latency
			readonly children: ReadonlyArray<Op>
			readonly fail?: FailRule | undefined
	  }
	| {
			readonly kind: "db"
			readonly system: "postgresql" | "redis"
			readonly namespace: string
			readonly operation: string
			readonly collection?: string
			readonly statement: string
			readonly latency: Latency
			readonly repeat?: (ctx: Ctx) => number
			readonly fail?: FailRule | undefined
	  }
	| {
			readonly kind: "external"
			readonly host: string
			readonly method: string
			readonly path: string
			readonly latency: Latency
			readonly fail?: FailRule | undefined
	  }
	| {
			readonly kind: "internal"
			readonly name: string
			readonly self: Latency
			readonly children: ReadonlyArray<Op>
	  }
	| { readonly kind: "publish"; readonly topic: string; readonly consumer: Consumer }

export interface Consumer {
	readonly service: ServiceName
	readonly topic: string
	readonly self: Latency
	readonly children: ReadonlyArray<Op>
}

const fixed =
	(median: number, spread = 0.35): Latency =>
	() => [median, spread]

const pg = (
	operation: string,
	collection: string,
	statement: string,
	latency: Latency = fixed(4, 0.5),
	extra: Partial<Extract<Op, { kind: "db" }>> = {},
): Op => ({
	kind: "db",
	system: "postgresql",
	namespace: "shop",
	operation,
	collection,
	statement,
	latency,
	...extra,
})

const redis = (operation: string, statement: string): Op => ({
	kind: "db",
	system: "redis",
	// The map names database nodes by namespace; the DB index "0" reads as noise.
	namespace: "cache",
	operation,
	statement,
	latency: fixed(0.8, 0.4),
})

// ── failures ────────────────────────────────────────────────────────────────

/**
 * Pool timeouts at a steady ~11% rather than independent coin flips, which at
 * ~60 payment requests per 5-minute bucket swing from 0% to 25%. Error diffusion
 * spaces failures evenly; a slow wave keeps the line from looking ruled.
 */
let poolDebt = 0
const poolTimesOut = (ctx: Ctx): boolean => {
	if (!ctx.incident) return false
	const wave = 1 + 0.15 * Math.sin((2 * Math.PI * ctx.at) / (37 * MINUTE))
	poolDebt += 0.11 * wave * (0.5 + ctx.rng.next())
	if (poolDebt < 1) return false
	poolDebt -= 1
	return true
}

/** Every payment-svc query waits on the same exhausted pool. */
const poolTimeout =
	(logPrefix: string, callers: ReadonlyArray<string>): FailRule =>
	(ctx) =>
		poolTimesOut(ctx)
			? {
					type: "ConnectionTimeout",
					message: "timed out acquiring a connection from the pool after 5000ms",
					logPrefix,
					durationMs: 5000 + ctx.rng.int(0, 40),
					stacktrace: [
						"ConnectionTimeout: timed out acquiring a connection from the pool after 5000ms",
						"    at Pool.acquire (/app/node_modules/pg-pool/index.js:45:11)",
						...callers.map((frame) => `    at ${frame}`),
					].join("\n"),
				}
			: null

const productCardTypeError: FailRule = (ctx) =>
	ctx.rng.chance(0.004)
		? {
				type: "TypeError",
				message: "Cannot read properties of undefined (reading 'price')",
				stacktrace: [
					"TypeError: Cannot read properties of undefined (reading 'price')",
					"    at ProductCard (/app/.next/server/app/product/[slug]/page.js:1:4821)",
					"    at renderWithHooks (/app/node_modules/react-dom/cjs/react-dom-server.node.production.js:3:12099)",
					"    at renderElement (/app/node_modules/react-dom/cjs/react-dom-server.node.production.js:3:14980)",
				].join("\n"),
			}
		: null

const variantKeyError: FailRule = (ctx) =>
	ctx.rng.chance(0.002)
		? {
				type: "KeyError",
				message: "'variant_id'",
				stacktrace: [
					"Traceback (most recent call last):",
					'  File "/app/catalog/api/products.py", line 74, in get_product',
					"    variant = variants_by_id[payload['variant_id']]",
					"KeyError: 'variant_id'",
				].join("\n"),
			}
		: null

const stockConflict: FailRule = (ctx) =>
	ctx.rng.chance(0.003)
		? {
				type: "*inventory.ConflictError",
				message: `stock reservation conflict: sku ${ctx.rng.int(1000, 9999)} version mismatch`,
				stacktrace: [
					"goroutine 412 [running]:",
					"github.com/acme/inventory-svc/internal/stock.(*Store).Reserve(0xc0001a2000, {0x10a3f80, 0xc000514120})",
					"\t/src/internal/stock/store.go:118 +0x2c4",
					"github.com/acme/inventory-svc/internal/http.(*Handler).reserve(0xc00012e0c0, {0x10a2c40, 0xc0002ae1c0}, 0xc000146300)",
					"\t/src/internal/http/reserve.go:57 +0x1b8",
				].join("\n"),
			}
		: null

const smtpDisconnect: FailRule = (ctx) =>
	ctx.rng.chance(0.006)
		? {
				type: "smtplib.SMTPServerDisconnected",
				message: "Connection unexpectedly closed",
				stacktrace: [
					"Traceback (most recent call last):",
					'  File "/app/notify/mailer.py", line 41, in send_receipt',
					"    smtp.send_message(message)",
					'  File "/usr/local/lib/python3.12/smtplib.py", line 405, in getreply',
					'    raise SMTPServerDisconnected("Connection unexpectedly closed")',
					"smtplib.SMTPServerDisconnected: Connection unexpectedly closed",
				].join("\n"),
			}
		: null

// ── call trees ──────────────────────────────────────────────────────────────

const authSession: Op = {
	kind: "server",
	service: "auth-svc",
	method: "GET",
	route: "/session",
	self: fixed(1.5),
	children: [redis("GET", "GET session:{id}")],
}

const productList: Op = {
	kind: "server",
	service: "catalog-api",
	method: "GET",
	route: "/products",
	self: fixed(6, 0.4),
	children: [
		redis("GET", "GET catalog:featured"),
		pg(
			"SELECT",
			"products",
			"SELECT id, slug, title, price_cents FROM products WHERE featured = $1 LIMIT $2",
		),
		// The N+1 the flamegraph shows as a wall: one variants query per product.
		pg("SELECT", "variants", "SELECT * FROM variants WHERE product_id = $1", fixed(1.6, 0.4), {
			repeat: (ctx) => ctx.rng.int(12, 16),
		}),
	],
}

const productDetail: Op = {
	kind: "server",
	service: "catalog-api",
	method: "GET",
	route: "/products/{id}",
	self: fixed(4, 0.4),
	fail: variantKeyError,
	children: [
		redis("GET", "GET product:{id}"),
		pg("SELECT", "products", "SELECT * FROM products WHERE id = $1"),
		pg("SELECT", "variants", "SELECT * FROM variants WHERE product_id = $1"),
	],
}

const stockLookup: Op = {
	kind: "server",
	service: "inventory-svc",
	method: "GET",
	route: "/stock/{sku}",
	self: fixed(1.2),
	children: [pg("SELECT", "stock", "SELECT available, version FROM stock WHERE sku = $1")],
}

const cartAdd: Op = {
	kind: "server",
	service: "cart-svc",
	method: "POST",
	route: "/carts/{id}/items",
	self: fixed(2),
	children: [stockLookup, redis("HSET", "HSET cart:{id} {sku} {qty}")],
}

const cartGet: Op = {
	kind: "server",
	service: "cart-svc",
	method: "GET",
	route: "/carts/{id}",
	self: fixed(1.4),
	children: [redis("HGETALL", "HGETALL cart:{id}")],
}

const reserveStock: Op = {
	kind: "server",
	service: "inventory-svc",
	method: "POST",
	route: "/reservations",
	self: fixed(2),
	fail: stockConflict,
	children: [
		pg(
			"UPDATE",
			"stock",
			"UPDATE stock SET available = available - $1, version = version + 1 WHERE sku = $2 AND version = $3",
			fixed(6, 0.5),
		),
	],
}

const charge: Op = {
	kind: "server",
	service: "payment-svc",
	method: "POST",
	route: "/charges",
	self: fixed(3),
	children: [
		pg(
			"INSERT",
			"payments",
			"INSERT INTO payments (order_id, amount_cents, currency, status) VALUES ($1, $2, $3, 'pending')",
			// Pool exhaustion: the insert now waits for a connection first.
			(ctx) => (ctx.incident ? [620, 0.9] : [9, 0.45]),
			{
				fail: poolTimeout("charge failed", [
					"PaymentRepository.insert (/app/src/payments/repository.ts:88:24)",
					"ChargeService.charge (/app/src/payments/charge.ts:142:18)",
					"handleCharge (/app/src/routes/charge.ts:31:9)",
				]),
			},
		),
		{
			kind: "external",
			host: "api.stripe.com",
			method: "POST",
			path: "/v1/payment_intents",
			latency: fixed(240, 0.35),
		},
		pg(
			"UPDATE",
			"payments",
			"UPDATE payments SET status = $1, provider_ref = $2 WHERE id = $3",
			fixed(5, 0.4),
		),
	],
}

/** The order confirmation page polls this until the charge settles. */
const chargeStatus: Op = {
	kind: "server",
	service: "payment-svc",
	method: "GET",
	route: "/charges/{id}",
	self: fixed(1.5),
	children: [
		pg(
			"SELECT",
			"payments",
			"SELECT status, provider_ref FROM payments WHERE order_id = $1",
			(ctx) => (ctx.incident ? [540, 0.9] : [3, 0.45]),
			{
				fail: poolTimeout("payment status lookup failed", [
					"PaymentRepository.findByOrder (/app/src/payments/repository.ts:41:24)",
					"handleChargeStatus (/app/src/routes/charge-status.ts:18:9)",
				]),
			},
		),
	],
}

const sendReceipt: Op = {
	kind: "server",
	service: "notification-svc",
	method: "POST",
	route: "/receipts",
	self: fixed(4),
	children: [
		{
			kind: "external",
			host: "smtp.postmarkapp.com",
			method: "POST",
			path: "/email",
			latency: fixed(180, 0.4),
			fail: smtpDisconnect,
		},
	],
}

const orderCreated: Consumer = {
	service: "order-worker",
	topic: "orders.created",
	self: fixed(3),
	children: [
		pg(
			"INSERT",
			"orders",
			"INSERT INTO orders (id, customer_id, total_cents, status) VALUES ($1, $2, $3, 'paid')",
		),
		pg(
			"INSERT",
			"order_items",
			"INSERT INTO order_items (order_id, sku, qty, price_cents) SELECT * FROM unnest($1, $2, $3, $4)",
		),
		sendReceipt,
	],
}

const checkout: Op = {
	kind: "server",
	service: "checkout-api",
	method: "POST",
	route: "/checkout",
	self: fixed(4),
	children: [
		authSession,
		cartGet,
		reserveStock,
		charge,
		{ kind: "publish", topic: "orders.created", consumer: orderCreated },
	],
}

const storefront = (method: string, route: string, children: ReadonlyArray<Op>, fail?: FailRule): Op => ({
	kind: "server",
	service: "storefront",
	method,
	route,
	self: fixed(method === "GET" ? 14 : 5, 0.4),
	children,
	fail,
})

/** Entry points with their share of traffic. */
export const ENTRY_POINTS: readonly [readonly [Op, number], ...(readonly [Op, number])[]] = [
	[storefront("GET", "/", [authSession, productList]), 24],
	[
		storefront(
			"GET",
			"/product/[slug]",
			[
				productDetail,
				stockLookup,
				{ kind: "internal", name: "render ProductPage", self: fixed(9, 0.4), children: [] },
			],
			productCardTypeError,
		),
		30,
	],
	[storefront("POST", "/api/cart", [authSession, cartAdd]), 14],
	[storefront("GET", "/cart", [authSession, cartGet]), 8],
	[storefront("POST", "/api/checkout", [checkout]), 14],
	[storefront("GET", "/order/[id]", [authSession, chargeStatus]), 16],
	[
		storefront("POST", "/api/login", [
			{
				kind: "server",
				service: "auth-svc",
				method: "POST",
				route: "/login",
				self: fixed(3),
				children: [
					pg("SELECT", "users", "SELECT id, password_hash FROM users WHERE email = $1"),
					{ kind: "internal", name: "argon2.verify", self: fixed(38, 0.15), children: [] },
					redis("SET", "SET session:{id} EX 86400"),
				],
			},
		]),
		6,
	],
]

/**
 * Traces per minute: peaks at 19:00 UTC (mid-afternoon US East, where the
 * screenshots render) and bottoms out before dawn. UTC so the curve never
 * depends on the seeding machine's timezone.
 */
export const traceRate = (at: number, peakPerMinute: number): number => {
	const hour = new Date(at).getUTCHours() + new Date(at).getUTCMinutes() / 60
	const daily = 0.5 + 0.5 * Math.cos((2 * Math.PI * (hour - 19)) / 24)
	return peakPerMinute * (0.3 + 0.7 * daily)
}
