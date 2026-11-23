// The OTLP/JSON bodies this SDK sends, byte for byte, against goldens captured
// from the OpenTelemetry JS SDK pipeline it replaced (sdk-trace 3.1, sdk-logs
// 3.1, otlp-transformer 0.301). Ingest must not see a difference.
import {
	type HrTime,
	ROOT_CONTEXT,
	SpanKind,
	SpanStatusCode,
	TraceFlags,
	trace,
	type Tracer,
} from "@opentelemetry/api"
import { describe, expect, it } from "vitest"
import goldenLogs from "./__golden__/otlp-logs.json"
import goldenTraces from "./__golden__/otlp-traces.json"
import { LoggerProvider, type ReadableLogRecord } from "./sdk/logs"
import { JsonLogsSerializer, JsonTraceSerializer } from "./sdk/otlp-json"
import { InMemorySpanExporter, SimpleSpanProcessor } from "./sdk/testing"
import { TraceState } from "./sdk/trace-state"
import { TracerProvider } from "./sdk/tracer"
import { resourceAttributes } from "./tracing"
import { SDK_NAME, SDK_VERSION } from "./version"

type Emit = Parameters<ReturnType<LoggerProvider["getLogger"]>["emit"]>[0]

const resourceFromAttributes = (attributes: Record<string, string>) => ({ attributes })

/** Span and log ids handed out in order, so the bodies are deterministic. */
const sequentialIds = () => {
	let next = 0
	const id = (length: number) => (++next).toString(16).padStart(length, "0")
	return { generateTraceId: () => id(32), generateSpanId: () => id(16) }
}

const wirePipeline = {
	spans(resource: Record<string, string>, record: (maple: Tracer, fetch: Tracer) => void): Uint8Array {
		const memory = new InMemorySpanExporter()
		const provider = new TracerProvider({
			resource: resourceFromAttributes(resource),
			idGenerator: sequentialIds(),
			spanProcessors: [new SimpleSpanProcessor({ exporter: memory })],
		})
		record(
			provider.getTracer(SDK_NAME, SDK_VERSION),
			provider.getTracer("@opentelemetry/instrumentation-fetch", "0.301.2"),
		)
		return JsonTraceSerializer.serializeRequest(memory.getFinishedSpans()) ?? new Uint8Array()
	},
	async logs(
		resource: Record<string, string>,
		record: (emit: (log: Emit) => void) => void,
	): Promise<Uint8Array> {
		const memory: ReadableLogRecord[] = []
		const provider = new LoggerProvider({
			resource: resourceFromAttributes(resource),
			processors: [
				{ onEmit: (log) => memory.push(log), forceFlush: async () => {}, shutdown: async () => {} },
			],
		})
		const logger = provider.getLogger(SDK_NAME, SDK_VERSION)
		record((log) => logger.emit(log))
		await provider.forceFlush()
		return JsonLogsSerializer.serializeRequest(memory) ?? new Uint8Array()
	},
}

const at = (ms: number): HrTime => [1_763_900_000 + Math.floor(ms / 1_000), (ms % 1_000) * 1_000_000 + 7]

const RESOURCE = resourceAttributes({
	serviceName: "acme-web",
	serviceNamespace: "shop",
	serviceVersion: "0123456789abcdef0123456789abcdef01234567",
	environment: "production",
})

const REMOTE = {
	traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
	spanId: "00f067aa0ba902b7",
	traceFlags: TraceFlags.SAMPLED,
	isRemote: true,
	traceState: new TraceState("vendor=abc,ot=th:8;rv:d5a8b2c1e3f405"),
}

/** Every shape the SDK puts on the wire: kinds, parents, links, events, statuses, attribute types. */
function recordSpans(maple: Tracer, fetch: Tracer): void {
	const pageload = maple.startSpan(
		"pageload /projects/:id",
		{
			startTime: at(0),
			attributes: { "url.path": "/projects/42", count: 3, ratio: 0.25, flag: true, tags: ["a", "b"] },
		},
		trace.setSpanContext(ROOT_CONTEXT, REMOTE),
	)
	const request = fetch.startSpan(
		"GET",
		{
			kind: SpanKind.CLIENT,
			startTime: at(10),
			attributes: { "http.request.method": "GET", "url.full": "https://api.test/projects/42" },
		},
		trace.setSpan(ROOT_CONTEXT, pageload),
	)
	request.addEvent("fetchStart", at(11))
	request.setAttribute("http.response.status_code", 503)
	request.setAttribute("http.response.header.content-type", ["application/json"])
	request.setStatus({ code: SpanStatusCode.ERROR })
	request.setAttribute("error.type", "503")
	request.end(at(120))
	const failure = maple.startSpan("browser.uncaught_error", {
		startTime: at(130),
		links: [{ context: { ...REMOTE, isRemote: false }, attributes: { reason: "cause" } }],
	})
	failure.recordException(
		{ name: "TypeError", message: "x is undefined", stack: "TypeError: x\n  at a.js:1:2" },
		at(130),
	)
	failure.setStatus({ code: SpanStatusCode.ERROR, message: "x is undefined" })
	failure.end(at(131))
	pageload.updateName("pageload /projects/:id")
	pageload.setAttribute("nested", { route: "/projects/:id", depth: 2 })
	pageload.end(at(500))
}

describe("OTLP/JSON on the wire", () => {
	it("serializes spans exactly as the OpenTelemetry JS SDK did", () => {
		const body = wirePipeline.spans(RESOURCE, recordSpans)
		expect(new TextDecoder().decode(body)).toBe(JSON.stringify(goldenTraces))
	})

	it("serializes log records exactly as the OpenTelemetry JS SDK did", async () => {
		const body = await wirePipeline.logs(RESOURCE, (emit) => {
			emit({
				eventName: "browser.web_vital",
				severityNumber: 9,
				severityText: "INFO",
				body: { name: "LCP", value: 1234.5 },
				attributes: { "session.id": "s-1", "web_vital.rating": "good" },
				timestamp: Date.UTC(2025, 10, 23, 12, 0, 0, 250),
				observedTimestamp: Date.UTC(2025, 10, 23, 12, 0, 1, 500),
				context: trace.setSpanContext(ROOT_CONTEXT, REMOTE),
			})
			emit({
				severityNumber: 17,
				severityText: "ERROR",
				body: "checkout failed",
				attributes: { attempt: 2 },
				timestamp: Date.UTC(2025, 10, 23, 12, 0, 2, 0),
				observedTimestamp: Date.UTC(2025, 10, 23, 12, 0, 2, 0),
				context: ROOT_CONTEXT,
			})
		})
		expect(new TextDecoder().decode(body)).toBe(JSON.stringify(goldenLogs))
	})
})
