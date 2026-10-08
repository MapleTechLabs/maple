import type { Log } from "@/api/warehouse/logs"

/**
 * A realistic slice of a production log stream for `/lab/logs`: HTTP access
 * lines, DB slow-query warnings, a payment outage with stack traces, JSON
 * bodies, debug chatter, and the resource attributes real SDKs send.
 *
 * Deterministic (a seeded PRNG) so before/after screenshots line up row for row.
 */

interface Template {
	service: string
	severity: "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL"
	weight: number
	body: (r: Rng) => string
	attrs: (r: Rng) => Record<string, string>
}

type Rng = () => number

function mulberry32(seed: number): Rng {
	let a = seed
	return () => {
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const pick = <A>(r: Rng, items: ReadonlyArray<A>): A => items[Math.floor(r() * items.length)] as A
const int = (r: Rng, min: number, max: number) => Math.floor(min + r() * (max - min + 1))
const hex = (r: Rng, length: number) =>
	Array.from({ length }, () => Math.floor(r() * 16).toString(16)).join("")

const ROUTES = [
	["GET", "/api/v1/products"],
	["GET", "/api/v1/products/:id"],
	["POST", "/api/v1/cart/items"],
	["GET", "/api/v1/cart"],
	["POST", "/api/v1/checkout"],
	["GET", "/healthz"],
	["DELETE", "/api/v1/cart/items/:id"],
] as const

const USERS = ["usr_8f2k1", "usr_3jd92", "usr_a01zz", "usr_77xq4", "usr_k2m9p"]

const RESOURCES: Record<string, Record<string, string>> = {
	"api-gateway": { "k8s.pod.name": "api-gateway-7d9f8c-x2lqp", "service.version": "2.14.0" },
	checkout: { "k8s.pod.name": "checkout-5b6d4-9kfts", "service.version": "3.5.0" },
	"payment-svc": { "k8s.pod.name": "payment-svc-84c7f-mm2rd", "service.version": "3.5.0" },
	inventory: { "k8s.pod.name": "inventory-6c8b9-qp4wn", "service.version": "1.22.3" },
	"auth-svc": { "k8s.pod.name": "auth-svc-59d7c-8hzrl", "service.version": "4.0.1" },
	"email-worker": { "k8s.pod.name": "email-worker-f4b2-t7cvx", "service.version": "0.9.12" },
}

let lastAccess: { method: string; route: string; status: number } = { method: "GET", route: "/", status: 200 }

const TEMPLATES: ReadonlyArray<Template> = [
	{
		service: "api-gateway",
		severity: "INFO",
		weight: 30,
		body: (r) => {
			const [method, route] = pick(r, ROUTES)
			lastAccess = { method, route, status: r() < 0.92 ? 200 : pick(r, [201, 204, 304]) }
			return `${method} ${route.replace(":id", String(int(r, 100, 9999)))} ${lastAccess.status} ${int(r, 3, 240)}ms`
		},
		// Called right after `body`, so the chips describe the same request.
		attrs: (r) => ({
			"http.request.method": lastAccess.method,
			"http.route": lastAccess.route,
			"http.response.status_code": String(lastAccess.status),
			"user.id": pick(r, USERS),
		}),
	},
	{
		service: "checkout",
		severity: "INFO",
		weight: 10,
		body: (r) => `Order ord_${hex(r, 10)} placed: ${int(r, 1, 6)} items, total $${int(r, 12, 480)}.${int(r, 10, 99)}`,
		attrs: (r) => ({ "user.id": pick(r, USERS), "order.items": String(int(r, 1, 6)) }),
	},
	{
		service: "inventory",
		severity: "WARN",
		weight: 6,
		body: (r) =>
			`Slow query (${int(r, 520, 2400)}ms): SELECT sku, quantity, reserved FROM stock_levels WHERE warehouse_id = $1 AND sku = ANY($2) FOR UPDATE`,
		attrs: (r) => ({
			"db.system.name": "postgresql",
			"db.operation.name": "SELECT",
			"db.collection.name": "stock_levels",
			duration_ms: String(int(r, 520, 2400)),
		}),
	},
	{
		service: "payment-svc",
		severity: "ERROR",
		weight: 5,
		body: (r) =>
			`Charge failed for ord_${hex(r, 10)}: connection pool exhausted (max=20, waiting=${int(r, 30, 140)})\n  at PgPool.acquire (src/db/pool.ts:118:13)\n  at ChargeService.capture (src/payments/charge.ts:62:21)\n  at async CheckoutHandler.handle (src/http/checkout.ts:41:5)`,
		attrs: (r) => ({
			"exception.type": "PoolExhaustedError",
			"exception.message": "connection pool exhausted",
			"http.response.status_code": "503",
			"user.id": pick(r, USERS),
		}),
	},
	{
		service: "api-gateway",
		severity: "ERROR",
		weight: 3,
		body: () => "POST /api/v1/checkout 503 3012ms upstream=payment-svc",
		attrs: (r) => ({
			"http.request.method": "POST",
			"http.route": "/api/v1/checkout",
			"http.response.status_code": "503",
			"user.id": pick(r, USERS),
		}),
	},
	{
		service: "auth-svc",
		severity: "INFO",
		weight: 7,
		body: (r) =>
			JSON.stringify({
				event: "session.refreshed",
				user: pick(r, USERS),
				ttl_s: 3600,
				mfa: r() < 0.3,
			}),
		attrs: (r) => ({ "user.id": pick(r, USERS), "enduser.auth.method": pick(r, ["passkey", "oauth", "password"]) }),
	},
	{
		service: "auth-svc",
		severity: "WARN",
		weight: 2,
		body: (r) => `Rate limit nearing for ip 203.0.113.${int(r, 2, 250)}: ${int(r, 80, 99)}/100 requests in 60s window`,
		attrs: () => ({ "client.address": "203.0.113.24", "rate_limit.remaining": "4" }),
	},
	{
		service: "email-worker",
		severity: "DEBUG",
		weight: 8,
		body: (r) => `Dequeued job ${hex(r, 8)} (order_confirmation) attempt=1 queue_depth=${int(r, 0, 40)}`,
		attrs: () => ({ "messaging.system": "sqs", "messaging.destination.name": "emails-transactional" }),
	},
	{
		service: "checkout",
		severity: "DEBUG",
		weight: 6,
		body: (r) => `cart.recalculate: subtotal=${int(r, 10, 300)}.00 tax=${int(r, 1, 30)}.40 shipping=4.99 promo=null`,
		attrs: (r) => ({ "user.id": pick(r, USERS) }),
	},
	{
		service: "inventory",
		severity: "INFO",
		weight: 5,
		body: (r) => `Reserved ${int(r, 1, 5)} units of SKU-${int(r, 1000, 9999)} for checkout, ${int(r, 0, 200)} remaining`,
		attrs: () => ({ "db.system.name": "postgresql" }),
	},
	{
		service: "payment-svc",
		severity: "FATAL",
		weight: 0.4,
		body: () =>
			"Unhandled promise rejection: PoolExhaustedError: timed out acquiring connection after 30000ms; process will exit",
		attrs: () => ({ "exception.type": "PoolExhaustedError", "process.exit_code": "1" }),
	},
	{
		service: "api-gateway",
		severity: "TRACE",
		weight: 3,
		body: (r) => `route matched ${pick(r, ROUTES)[1]} -> upstream ${pick(r, ["checkout", "inventory", "auth-svc"])}:8080`,
		attrs: () => ({}),
	},
]

const TOTAL_WEIGHT = TEMPLATES.reduce((sum, t) => sum + t.weight, 0)

function pickTemplate(r: Rng, incident: boolean): Template {
	// The payment outage concentrates errors in one band of the stream.
	if (incident && r() < 0.35) return pick(r, TEMPLATES.filter((t) => t.service === "payment-svc" || t.severity === "ERROR"))
	let n = r() * TOTAL_WEIGHT
	for (const template of TEMPLATES) {
		n -= template.weight
		if (n <= 0) return template
	}
	return TEMPLATES[0] as Template
}

export function buildLogsLabFixture(anchorMs: number, count = 400): Log[] {
	const r = mulberry32(42)
	let t = anchorMs
	return Array.from({ length: count }, (_, index) => {
		t -= int(r, 40, 2600)
		const incident = index > 20 && index < 90
		const template = pickTemplate(r, incident)
		const traced = template.service !== "email-worker" || r() < 0.5
		return {
			timestamp: new Date(t).toISOString(),
			severityText: template.severity,
			severityNumber: { TRACE: 1, DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17, FATAL: 21 }[template.severity],
			serviceName: template.service,
			body: template.body(r),
			traceId: (traced ? hex(r, 32) : "") as Log["traceId"],
			spanId: (traced ? hex(r, 16) : "") as Log["spanId"],
			logAttributes: template.attrs(r),
			resourceAttributes: {
				"service.name": template.service,
				"deployment.environment.name": "production",
				"cloud.region": "eu-central-1",
				...RESOURCES[template.service],
			},
		}
	})
}
