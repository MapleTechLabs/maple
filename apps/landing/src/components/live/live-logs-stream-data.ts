import type { toLogRowView } from "@maple/views/ui/logs/log-row-view"
import { Array as Arr, String as Str } from "effect"

/** The warehouse row the stream renders (`LogRow` from the query engine). */
type LogRow = Parameters<typeof toLogRowView>[0]

/**
 * Example logs for LiveLogsStream: a few seconds of a checkout service, one declined charge in
 * the middle. Deterministic, newest first, like /logs.
 */

const NEWEST_MS = Date.UTC(2026, 4, 3, 12, 4, 21, 384)

type Entry = Readonly<{
	agoMs: number
	severity: "DEBUG" | "INFO" | "WARN" | "ERROR"
	service: string
	body: string
	attributes?: Record<string, string>
}>

const SEVERITY_NUMBER = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 } as const

const ENTRIES: ReadonlyArray<Entry> = [
	{
		agoMs: 0,
		severity: "INFO",
		service: "api-gateway",
		body: "POST /api/checkout 402",
		attributes: { "http.request.method": "POST", "http.response.status_code": "402" },
	},
	{
		agoMs: 41,
		severity: "INFO",
		service: "order-service",
		body: "order canceled order_id=ord_8421 reason=payment_declined",
	},
	{
		agoMs: 63,
		severity: "WARN",
		service: "payment-svc",
		body: "falling back to authorize-only flow",
		attributes: { "payment.provider": "stripe" },
	},
	{
		agoMs: 88,
		severity: "ERROR",
		service: "payment-svc",
		body: "card declined: insufficient_funds",
		attributes: { "exception.type": "CardDeclinedError", "payment.provider": "stripe" },
	},
	{
		agoMs: 292,
		severity: "INFO",
		service: "payment-svc",
		body: "charging card amount=129.00 currency=EUR",
		attributes: { "payment.provider": "stripe" },
	},
	{
		agoMs: 318,
		severity: "DEBUG",
		service: "order-service",
		body: "evaluate flag fast_checkout=false cohort=A2",
	},
	{
		agoMs: 344,
		severity: "INFO",
		service: "order-service",
		body: "reserved 3 items sku=SKU-9081,SKU-1142,SKU-0077",
		attributes: { "db.system.name": "postgresql" },
	},
	{ agoMs: 371, severity: "WARN", service: "order-service", body: "stock low sku=SKU-9081 qty=3" },
	{
		agoMs: 402,
		severity: "INFO",
		service: "auth-service",
		body: "token verified user=u_4109 scope=checkout",
	},
	{ agoMs: 431, severity: "DEBUG", service: "auth-service", body: "jwks cache hit kid=2026-05" },
	{
		agoMs: 455,
		severity: "INFO",
		service: "api-gateway",
		body: "POST /api/checkout received",
		attributes: { "http.request.method": "POST" },
	},
	{
		agoMs: 812,
		severity: "INFO",
		service: "api-gateway",
		body: "GET /api/cart 200",
		attributes: { "http.request.method": "GET", "http.response.status_code": "200" },
	},
	{
		agoMs: 836,
		severity: "INFO",
		service: "order-service",
		body: "loaded cart user=u_4109 items=3",
		attributes: { "db.system.name": "postgresql" },
	},
	{
		agoMs: 1204,
		severity: "INFO",
		service: "api-gateway",
		body: "GET /api/inventory 200",
		attributes: { "http.request.method": "GET", "http.response.status_code": "200" },
	},
	{
		agoMs: 1530,
		severity: "DEBUG",
		service: "order-service",
		body: "reschedule retry_at=12:04:25 job=sync-inventory",
	},
	{
		agoMs: 1877,
		severity: "INFO",
		service: "api-gateway",
		body: "POST /api/feedback 201",
		attributes: { "http.request.method": "POST", "http.response.status_code": "201" },
	},
]

/** `2026-05-03 12:04:21.384` with nanoseconds, as the warehouse stores it. */
const exactOf = (iso: string): string => `${Str.replace("Z", "")(Str.replace("T", " ")(iso))}000000`

export const LOGS_STREAM_ROWS: ReadonlyArray<LogRow> = Arr.map(ENTRIES, (entry) => {
	const iso = new Date(NEWEST_MS - entry.agoMs).toISOString()
	return {
		timestamp: iso,
		exactTimestamp: exactOf(iso),
		severityText: entry.severity,
		severityNumber: SEVERITY_NUMBER[entry.severity],
		serviceName: entry.service,
		body: entry.body,
		traceId: undefined,
		spanId: undefined,
		logAttributes: entry.attributes ?? {},
		resourceAttributes: { "deployment.environment.name": "production" },
	}
})
