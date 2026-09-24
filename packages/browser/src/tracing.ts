import {
	consentAllowedSince,
	hasConsent,
	readSessionSink,
	recordTraceId,
	scrubUrl,
	SDK_HINT_HEADER,
	sdkHint,
} from "@maple/browser-session"
import { context, propagation, ProxyTracerProvider, type Tracer, trace } from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { registerInstrumentations } from "@opentelemetry/instrumentation"
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch"
import { resourceFromAttributes } from "@opentelemetry/resources"
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import type { ResolvedConfig } from "./config"
import { SDK_NAME, SDK_VERSION } from "./version"

/** Span attributes that carry a page or request URL. */
const URL_ATTRIBUTES = ["url.full", "http.url"] as const

/**
 * Captures every span's trace id into the session sink, and redacts URL
 * attributes before anything can export them. Lightweight: runs alongside the
 * BatchSpanProcessor, does no export of its own.
 */
export class TraceIdCollector implements SpanProcessor {
	constructor(private readonly getUserId: () => string | undefined = () => undefined) {}

	onStart(span: Span): void {
		// The fetch instrumentation sets `url.full` once, at creation, so this is
		// the one place it has to be rewritten.
		for (const key of URL_ATTRIBUTES) {
			const value = span.attributes[key]
			if (typeof value === "string") span.setAttribute(key, scrubUrl(value))
		}
		if (!hasConsent()) return
		recordTraceId(span.spanContext().traceId)
		const sessionId = readSessionSink()?.sessionId
		if (sessionId !== undefined) span.setAttribute("session.id", sessionId)
		const userId = this.getUserId()
		if (userId !== undefined) span.setAttribute("user.id", userId)
	}
	onEnd(_span: ReadableSpan): void {}
	forceFlush(): Promise<void> {
		return Promise.resolve()
	}
	shutdown(): Promise<void> {
		return Promise.resolve()
	}
}

/**
 * Drops buffered spans captured while consent was absent. Checking start time,
 * rather than only permission at flush time, also prevents a late grant from
 * releasing spans that began before that grant.
 */
class ConsentSpanExporter implements SpanExporter {
	constructor(private readonly inner: SpanExporter) {}

	export(spans: ReadableSpan[], callback: (result: { code: number; error?: Error }) => void): void {
		const since = consentAllowedSince()
		if (!hasConsent() || !Number.isFinite(since)) {
			callback({ code: 0 })
			return
		}
		const eligible = spans.filter(
			(span) => span.startTime[0] * 1_000 + span.startTime[1] / 1_000_000 >= since,
		)
		if (eligible.length === 0) {
			callback({ code: 0 })
			return
		}
		this.inner.export(eligible, callback)
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush?.() ?? Promise.resolve()
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown()
	}
}

/**
 * How long a span may sit in the batch queue before export.
 *
 * Shorter than OTel's 5s default: in a browser the queue is only as durable as
 * the tab, and the unload flush below is a best-effort catch rather than a
 * guarantee (a crashed or killed tab fires neither event). 2s trades a few more
 * requests for a materially smaller loss window.
 */
const EXPORT_INTERVAL_MS = 2_000

/**
 * The provider this SDK registered, while it is live. `captureException` spans
 * through it directly: the global provider may belong to the host app, which
 * registered first and so kept the global.
 */
let mapleProvider: WebTracerProvider | undefined

/** A tracer on Maple's provider when tracing is live, otherwise the global one. */
export function mapleTracer(name: string, version: string): Tracer {
	return (mapleProvider ?? trace.getTracerProvider()).getTracer(name, version)
}

/**
 * Set up browser OTel tracing exporting to Maple's ingest. When
 * `tracingInstrumentFetch` is true, fetch() calls are auto-instrumented and
 * their trace ids feed the session. Disable it when an external tracer (e.g.
 * the Effect client SDK) already instruments requests — that tracer feeds the
 * session via the published sink instead, and this avoids redundant duplicate
 * network spans. Returns a shutdown function.
 *
 * `session.id` is deliberately **not** a resource attribute: the resource is
 * fixed for the provider's lifetime, but sessions rotate under it (idle
 * rotation, consent revoke→re-grant), so a resource-level id would attribute
 * every post-rotation span to the ended session. `TraceIdCollector` stamps the
 * live id per span instead.
 */
export function setupTracing(config: ResolvedConfig): () => Promise<void> {
	const attributes: Record<string, string> = {
		[ATTR_SERVICE_NAME]: config.serviceName,
		"maple.sdk.type": "browser",
	} satisfies Record<string, string>
	if (config.serviceNamespace) {
		attributes["service.namespace"] = config.serviceNamespace
	}
	if (config.serviceVersion) {
		attributes[ATTR_SERVICE_VERSION] = config.serviceVersion
		// A semver release string belongs in `service.version` but not in
		// `vcs.*` — only a SHA-shaped value is stamped as the head revision.
		if (/^[0-9a-f]{7,40}$/i.test(config.serviceVersion)) {
			attributes["vcs.ref.head.revision"] = config.serviceVersion
		}
	}
	if (config.environment) {
		// Dual-emit: legacy key (pre-extracted by Tinybird MVs) + the canonical
		// resource attribute. Keep both until the MVs coalesce them.
		attributes["deployment.environment"] = config.environment
		attributes["deployment.environment.name"] = config.environment
	}

	const exporter = new ConsentSpanExporter(
		new OTLPTraceExporter({
			url: `${config.endpoint}/v1/traces`,
			headers: {
				Authorization: `Bearer ${config.ingestKey}`,
				// Ingest records this as `maple.sdk`; a page cannot set `user-agent`.
				[SDK_HINT_HEADER]: sdkHint(SDK_NAME, SDK_VERSION),
			},
		}),
	)

	const provider = new WebTracerProvider({
		resource: resourceFromAttributes(attributes),
		// The id only — the rest of the identity (email, group) belongs on the
		// session row, not stamped onto every span on the hot path.
		spanProcessors: [
			new TraceIdCollector(() => config.identity?.id),
			new BatchSpanProcessor(exporter, { scheduledDelayMillis: EXPORT_INTERVAL_MS }),
		],
	})
	provider.register()
	mapleProvider = provider
	// The OTel globals are first-write-wins. If a host app registered its own
	// provider before us, ours never became the global one: remember whether we
	// won so shutdown releases only globals this SDK actually owns. Everything
	// this SDK spans passes `provider` explicitly, so losing the global costs
	// nothing but ambient context.
	const globalProvider = trace.getTracerProvider()
	const ownsGlobals =
		globalProvider === provider ||
		(globalProvider instanceof ProxyTracerProvider && globalProvider.getDelegate() === provider)

	// Without this the batch processor's queue dies with the tab: its only flush
	// is `provider.shutdown()`, which a host app that never calls `shutdown()`
	// never reaches. That silently loses the last window of spans on every tab
	// close — which is exactly the window containing whatever made the user
	// leave. Session rows and events already get this treatment on the way out;
	// traces were the one signal that didn't.
	//
	// Both events are needed: `visibilitychange → hidden` is the only reliable
	// one on mobile, `pagehide` covers desktop tab close and navigation. Flushing
	// twice is harmless — the second finds an empty queue.
	const onExit = (): void => {
		void provider.forceFlush().catch(() => {
			// Best-effort on the way out; never throw into the host app.
		})
	}
	const onVisibilityChange = (): void => {
		if (document.visibilityState === "hidden") onExit()
	}
	const canListen = typeof document !== "undefined" && typeof document.addEventListener === "function"
	if (canListen) {
		document.addEventListener("visibilitychange", onVisibilityChange)
		window.addEventListener("pagehide", onExit)
	}

	const unregisterInstrumentations = config.tracingInstrumentFetch
		? registerInstrumentations({
				// Explicit, not the global: a host app that registered its own provider
				// first owns the global, and these spans would otherwise go to it.
				tracerProvider: provider,
				instrumentations: [
					new FetchInstrumentation({
						// Maple's own ingest calls are not traced at all.
						ignoreUrls: [new RegExp(`${escapeRegExp(config.endpoint)}/v1/`)],
						// `traceparent` goes to same-origin requests only, unless the app
						// lists the cross-origin APIs that accept it.
						propagateTraceHeaderCorsUrls: [...config.propagateTraceHeaderCorsUrls],
					}),
				],
			})
		: undefined

	return async () => {
		if (canListen) {
			document.removeEventListener("visibilitychange", onVisibilityChange)
			window.removeEventListener("pagehide", onExit)
		}
		unregisterInstrumentations?.()
		if (mapleProvider === provider) mapleProvider = undefined
		await provider.shutdown()
		// Release the globals so a later init() can register a live provider.
		// The global proxy keeps delegating to this now-shut-down provider
		// otherwise, and the documented init → shutdown → init lifecycle would
		// silently export nothing on the second session.
		if (ownsGlobals) {
			trace.disable()
			context.disable()
			propagation.disable()
		}
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
