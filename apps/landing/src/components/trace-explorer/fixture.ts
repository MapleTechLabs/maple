import { SpanId, TraceId } from "@maple/domain/primitives"
import type { SpanNode } from "@maple/ui/lib/types"
import { Schema } from "effect"

/** The fixture trace the trace explorer artifact draws: POST /checkout over four services. */

export const BASE_TIME = "2024-01-15T14:23:01.000Z"
export const TRACE_ID = "a3f8c1d2e5b7f901"
export const TOTAL_DURATION_MS = 203
export const SERVICES = ["api-gateway", "auth-service", "order-service", "payment-svc"] as const

const traceId = Schema.decodeSync(TraceId)(TRACE_ID)
const toSpanId = Schema.decodeSync(SpanId)
const at = (offsetMs: number): string => new Date(new Date(BASE_TIME).getTime() + offsetMs).toISOString()

type SpanFields = Pick<
	SpanNode,
	"spanName" | "serviceName" | "durationMs" | "startTime" | "spanKind" | "depth"
> &
	Partial<Pick<SpanNode, "parentSpanId" | "spanAttributes" | "children">> & { readonly spanId: string }

const span = ({ spanId, ...fields }: SpanFields): SpanNode => ({
	traceId,
	parentSpanId: "",
	statusCode: "Ok",
	statusMessage: "",
	spanAttributes: {},
	resourceAttributes: {},
	children: [],
	...fields,
	spanId: toSpanId(spanId),
})

const chargeCard = span({
	spanId: "span-7",
	spanName: "chargeCard",
	serviceName: "payment-svc",
	durationMs: 45,
	startTime: at(89),
	parentSpanId: "span-6",
	spanKind: "SPAN_KIND_INTERNAL",
	depth: 3,
})
const processPayment = span({
	spanId: "span-6",
	spanName: "processPayment",
	serviceName: "payment-svc",
	durationMs: 57,
	startTime: at(85),
	parentSpanId: "span-3",
	spanKind: "SPAN_KIND_CLIENT",
	depth: 2,
	children: [chargeCard],
})
const validateInventory = span({
	spanId: "span-4",
	spanName: "validateInventory",
	serviceName: "order-service",
	durationMs: 20,
	startTime: at(38),
	parentSpanId: "span-3",
	spanKind: "SPAN_KIND_INTERNAL",
	depth: 2,
})
const reserveItems = span({
	spanId: "span-5",
	spanName: "reserveItems",
	serviceName: "order-service",
	durationMs: 16,
	startTime: at(62),
	parentSpanId: "span-3",
	spanKind: "SPAN_KIND_INTERNAL",
	depth: 2,
})
const createOrder = span({
	spanId: "span-3",
	spanName: "createOrder",
	serviceName: "order-service",
	durationMs: 85,
	startTime: at(34),
	parentSpanId: "span-1",
	spanKind: "SPAN_KIND_SERVER",
	depth: 1,
	children: [validateInventory, reserveItems, processPayment],
})
const validateToken = span({
	spanId: "span-2",
	spanName: "validateToken",
	serviceName: "auth-service",
	durationMs: 24,
	startTime: at(6),
	parentSpanId: "span-1",
	spanKind: "SPAN_KIND_CLIENT",
	depth: 1,
})
const sendConfirmation = span({
	spanId: "span-8",
	spanName: "sendConfirmation",
	serviceName: "order-service",
	durationMs: 30,
	startTime: at(148),
	parentSpanId: "span-1",
	spanKind: "SPAN_KIND_CLIENT",
	depth: 1,
})
const rootSpan = span({
	spanId: "span-1",
	spanName: "POST /checkout",
	serviceName: "api-gateway",
	durationMs: 203,
	startTime: BASE_TIME,
	spanKind: "SPAN_KIND_SERVER",
	spanAttributes: { "http.method": "POST", "http.route": "/checkout", "http.status_code": "200" },
	depth: 0,
	children: [validateToken, createOrder, sendConfirmation],
})

export const ROOT_SPANS: ReadonlyArray<SpanNode> = [rootSpan]

/** The waterfall's rows, in tree order, each with its service's chart colour. */
export const WATERFALL_ROWS: ReadonlyArray<{ readonly span: SpanNode; readonly color: 1 | 2 | 3 | 4 }> = [
	{ span: rootSpan, color: 1 },
	{ span: validateToken, color: 2 },
	{ span: createOrder, color: 3 },
	{ span: validateInventory, color: 3 },
	{ span: reserveItems, color: 3 },
	{ span: processPayment, color: 4 },
	{ span: chargeCard, color: 4 },
	{ span: sendConfirmation, color: 3 },
]
