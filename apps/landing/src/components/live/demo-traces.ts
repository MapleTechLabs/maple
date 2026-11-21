import { SpanId, TraceId } from "@maple/primitives"
import type { TraceData } from "@maple/views/traces/trace-data"
import type { SpanNode } from "@maple/ui/lib/types"
import { Array as Arr, Schema } from "effect"

/**
 * Example traces for the /integrations/<runtime> heroes: the span names each runtime's
 * instrumentation produces, so the Go page shows a Go request and the LangChain page an agent run.
 */

type Kind = "server" | "client" | "internal" | "producer" | "consumer"

interface DemoSpan {
	readonly name: string
	readonly service: string
	readonly kind: Kind
	/** Offset from the trace start, in ms. */
	readonly at: number
	readonly ms: number
	readonly attrs?: Readonly<Record<string, string>>
	readonly children?: ReadonlyArray<DemoSpan>
}

const BASE_TIME = "2024-01-15T14:23:01.000Z"
const toTraceId = Schema.decodeSync(TraceId)
const toSpanId = Schema.decodeSync(SpanId)
const KIND = {
	server: "SPAN_KIND_SERVER",
	client: "SPAN_KIND_CLIENT",
	internal: "SPAN_KIND_INTERNAL",
	producer: "SPAN_KIND_PRODUCER",
	consumer: "SPAN_KIND_CONSUMER",
} as const

const s = (
	name: string,
	service: string,
	kind: Kind,
	at: number,
	ms: number,
	children?: ReadonlyArray<DemoSpan>,
	attrs?: Readonly<Record<string, string>>,
): DemoSpan => ({ name, service, kind, at, ms, children, attrs })

const DEMO_TRACES = {
	go: s("GET /api/orders/{id}", "orders-api", "server", 0, 48, [
		s("SELECT orders", "orders-api", "client", 2, 7, [], { "db.system.name": "postgresql" }),
		s("inventory.v1.Inventory/Reserve", "orders-api", "client", 11, 29, [
			s("inventory.v1.Inventory/Reserve", "inventory-svc", "server", 13, 25, [
				s("UPDATE stock", "inventory-svc", "client", 16, 12, [], { "db.system.name": "postgresql" }),
			]),
		]),
	]),
	java: s("GET /api/orders/{id}", "shop-api", "server", 0, 86, [
		s("SELECT shop.orders", "shop-api", "client", 4, 11),
		s("SELECT shop.order_items", "shop-api", "client", 17, 9),
		s("orders publish", "shop-api", "producer", 31, 6, [
			s("orders process", "billing-worker", "consumer", 40, 38, [
				s("INSERT billing.invoices", "billing-worker", "client", 46, 14),
			]),
		]),
	]),
	dotnet: s("GET api/orders/{id}", "orders-api", "server", 0, 74, [
		s("SELECT app.Orders", "orders-api", "client", 3, 12),
		s("HTTP POST", "orders-api", "client", 20, 46, [
			s("POST charges", "payments-api", "server", 23, 41, [
				s("INSERT app.Charges", "payments-api", "client", 30, 15),
			]),
		]),
	]),
	ruby: s("GET /orders/:id", "store-web", "server", 0, 92, [
		s("SELECT store_production", "store-web", "client", 6, 8),
		s("redis GET", "store-web", "client", 17, 2),
		s("app/views/orders/show.html.erb", "store-web", "internal", 22, 41),
		s("default publish", "store-web", "producer", 70, 4),
	]),
	laravel: s("GET /orders/{order}", "store-app", "server", 0, 81, [
		s("SELECT orders", "store-app", "client", 5, 9),
		s("HTTP GET", "store-app", "client", 18, 34, [s("GET /rates", "shipping-api", "server", 21, 29)]),
		s("orders.show", "store-app", "internal", 56, 18),
	]),
	rust: s("request", "orders-rs", "server", 0, 39, [
		s("load_order", "orders-rs", "internal", 2, 11, [
			s("SELECT orders", "orders-rs", "client", 3, 8, [], { "db.system.name": "postgresql" }),
		]),
		s("HTTP POST", "orders-rs", "client", 16, 20, [s("POST /charges", "payments-api", "server", 18, 16)]),
	]),
	"vercel-ai-sdk": s("invoke_agent support_agent", "support-agent", "internal", 0, 3120, [
		s("chat gpt-4o-mini", "support-agent", "client", 10, 940),
		s("execute_tool lookup_order", "support-agent", "internal", 960, 180, [
			s("GET /api/orders/{id}", "orders-api", "server", 975, 150),
		]),
		s("chat gpt-4o-mini", "support-agent", "client", 1150, 1950),
	]),
	langchain: s("invoke_agent assistant", "support-agent", "internal", 0, 2840, [
		s("chat gpt-4o-mini", "support-agent", "client", 15, 820),
		s("invoke_workflow tools", "support-agent", "internal", 850, 310, [
			s("execute_tool get_weather", "support-agent", "internal", 855, 295),
		]),
		s("chat gpt-4o-mini", "support-agent", "client", 1170, 1650),
	]),
	"openai-agents": s("invoke_agent Triage agent", "support-agent", "internal", 0, 4210, [
		s("chat gpt-4.1", "support-agent", "client", 12, 1020),
		s("execute_tool transfer_to_billing_agent", "support-agent", "internal", 1040, 4),
		s("invoke_agent Billing agent", "support-agent", "internal", 1050, 3150, [
			s("chat gpt-4.1", "support-agent", "client", 1060, 880),
			s("execute_tool get_invoice", "support-agent", "internal", 1950, 240),
			s("chat gpt-4.1", "support-agent", "client", 2200, 1990),
		]),
	]),
	"cloudflare-workers": s("fetch", "edge-router", "server", 0, 58, [
		s("kv_get", "edge-router", "client", 2, 4),
		s("fetch", "edge-router", "client", 8, 37),
		s("r2_put", "edge-router", "client", 47, 9),
	]),
	react: s("navigate /projects/:projectId", "acme-web", "internal", 0, 212, [
		s("loader project", "acme-web", "internal", 3, 196, [
			s("HTTP GET", "acme-web", "client", 5, 188, [
				s("GET /api/projects/{id}", "projects-api", "server", 30, 140, [
					s("SELECT projects", "projects-api", "client", 36, 22),
				]),
			]),
		]),
	]),
} satisfies Record<string, DemoSpan>

export type DemoTraceId = keyof typeof DEMO_TRACES

export const isDemoTraceId = (id: string): id is DemoTraceId => id in DEMO_TRACES

const at = (offsetMs: number): string => new Date(new Date(BASE_TIME).getTime() + offsetMs).toISOString()
const hex = (n: number, width: number) => n.toString(16).padStart(width, "0")

/** The waterfall data for one example trace, with the frame's head line. */
export const demoTrace = (id: DemoTraceId): { trace: TraceData; head: string; spans: number; ms: number } => {
	const root = DEMO_TRACES[id]
	const traceId = toTraceId(hex(Object.keys(DEMO_TRACES).indexOf(id) + 1, 16))
	let counter = 0
	const build = (spec: DemoSpan, parentSpanId: string, depth: number): SpanNode => {
		counter += 1
		const spanId = toSpanId(hex(counter, 16))
		return {
			traceId,
			spanId,
			parentSpanId,
			spanName: spec.name,
			serviceName: spec.service,
			durationMs: spec.ms,
			startTime: at(spec.at),
			spanKind: KIND[spec.kind],
			statusCode: "Ok",
			statusMessage: "",
			spanAttributes: spec.attrs ?? {},
			resourceAttributes: {},
			depth,
			children: Arr.map(spec.children ?? [], (child) => build(child, spanId, depth + 1)),
		}
	}
	const rootSpan = build(root, "", 0)
	const flat = (node: SpanNode): SpanNode[] => [node, ...Arr.flatMap(node.children, flat)]
	const spans = flat(rootSpan)
	return {
		trace: { traceId, spans, rootSpans: [rootSpan], totalDurationMs: root.ms, traceStartTime: BASE_TIME },
		head: root.name,
		spans: spans.length,
		ms: root.ms,
	}
}
