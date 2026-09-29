// Navigation and data-loading spans.
//
// The router reports where a navigation starts and ends, and the route's data
// loading runs inside `traced`. That makes one click one trace: the navigation
// span, the loader spans under it, the `fetch` spans they start, and the
// backend spans behind those. The first navigation, the page load, joins the
// trace the server rendered the page under.
//
// Everything spans through Maple's own provider, never the global one (a host
// app that registered its provider first owns that). Without a live provider
// (before `init()`, after `shutdown()`, tracing disabled, consent not yet
// granted, or on a server) nothing is spanned and `traced` only runs `fn`.
import { hasConsent, scrubUrl } from "@maple/browser-session"
import {
	type Context,
	context,
	isSpanContextValid,
	type Span,
	type SpanContext,
	trace,
} from "@opentelemetry/api"
import { captureException, recordFailure } from "./errors"
import { liveMapleTracer } from "./tracing"
import { SDK_NAME, SDK_VERSION } from "./version"

export interface TracedOptions {
	/** Return `false` for throws that aren't errors, like redirects or not-found. Default: every throw is an error. */
	// BOUNDARY: a thrown value is unparsed by definition; the app narrows it.
	readonly isFailure?: ((error: unknown) => boolean) | undefined
}

/**
 * The navigation in flight. Only ever set in a browser: a server shares module
 * state across requests.
 */
let navigation: { readonly span: Span; readonly kind: "pageload" | "navigate" } | undefined
/**
 * Whether the next navigation is a `pageload`: the first since the document
 * loaded, or since `shutdown()`. Consumed even when nothing is spanned
 * (tracing not live yet, consent pending): a later click is not the page load.
 */
let firstLoad = true
/**
 * Whether the document's own page load is still to come. Unlike `firstLoad`,
 * never reset: a `pageload` after `shutdown()` and a new `init()` is long past
 * the server render, and must not join its trace.
 */
let documentLoad = true

/** Spans `traced` opened, which a nested `traced` may parent to instead of the navigation. */
const tracedSpans = new WeakSet<Span>()

/**
 * Maple's tracer, while tracing is live and consent is given. A consent revoke
 * leaves the provider up but drops what it spans: an error recorded then would
 * be claimed without ever being exported.
 */
const tracer = () => (hasConsent() ? liveMapleTracer(SDK_NAME, SDK_VERSION) : undefined)

/** End the open navigation as interrupted: something other than its route finishing ended it. */
function interruptNavigation(): void {
	navigation?.span.setAttribute("app.navigation.interrupted", true)
	navigation?.span.end()
	navigation = undefined
}

export function startNavigation(path: string): void {
	if (typeof window === "undefined") return
	interruptNavigation()
	const kind = firstLoad ? "pageload" : "navigate"
	const joinServer = documentLoad
	firstLoad = false
	documentLoad = false
	const live = tracer()
	if (!live) return
	const parent = (joinServer ? serverContext() : undefined) ?? context.active()
	navigation = { kind, span: live.startSpan(kind, { attributes: { "url.path": scrubUrl(path) } }, parent) }
	// A page left mid-navigation still exports it. Capture phase, so this runs
	// before the provider's own `pagehide` flush (at the target, capture
	// listeners run first). Registering the same listener again is a no-op.
	window.addEventListener("pagehide", interruptNavigation, { capture: true })
}

export function endNavigation(route?: string): void {
	if (!navigation) return
	// A template by contract, but redacted like a URL in case it is a concrete one
	if (route) navigation.span.updateName(`${navigation.kind} ${scrubUrl(route)}`)
	navigation.span.end()
	navigation = undefined
}

export async function traced<T>(name: string, fn: () => Promise<T>, options: TracedOptions = {}): Promise<T> {
	const live = tracer()
	if (!live) return fn()
	// `fn` runs synchronously inside the span's context, so requests it starts
	// before its first `await` are children of the span. The browser has no
	// async context: anything after that `await` is not.
	return live.startActiveSpan(name, {}, parentContext(), async (span) => {
		tracedSpans.add(span)
		try {
			return await fn()
		} catch (error) {
			if (isFailure(options, error)) {
				// An unsampled span drops what it records: report the failure on its own, which is always kept.
				if (span.isRecording()) recordFailure(span, error)
				else captureException(error, { name })
			}
			throw error
		} finally {
			span.end()
		}
	})
}

/**
 * The open navigation, unless a `traced` span is active: a `traced` inside
 * another `traced` nests under that one.
 */
function parentContext(): Context {
	const active = context.active()
	const activeSpan = trace.getSpan(active)
	if (!navigation || (activeSpan && tracedSpans.has(activeSpan))) return active
	return trace.setSpan(active, navigation.span)
}

/** `isFailure` is the app's code: if it throws, the original error still propagates. */
function isFailure(options: TracedOptions, error: unknown): boolean {
	try {
		return options.isFailure?.(error) ?? true
	} catch {
		return true
	}
}

/**
 * End the open navigation so it exports with the provider's last flush, and
 * start the next `init()` at a page load. Called by `shutdown()`.
 */
export function resetNavigation(): void {
	interruptNavigation()
	firstLoad = true
}

/** Test seam: as if the document had just loaded. */
export function resetNavigationForTests(): void {
	resetNavigation()
	documentLoad = true
}

/**
 * The trace the server rendered this page under: a `Server-Timing:
 * traceparent;desc="…"` entry on the document response, else a `<meta
 * name="traceparent">` tag.
 */
function serverContext(): Context | undefined {
	const [page] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[]
	const spanContext =
		parseTraceparent(page?.serverTiming?.find((entry) => entry.name === "traceparent")?.description) ??
		parseTraceparent(document.querySelector<HTMLMetaElement>('meta[name="traceparent"]')?.content)
	return spanContext && trace.setSpanContext(context.active(), spanContext)
}

/**
 * W3C `version-traceid-parentid-flags`. Parsed here rather than through the
 * global propagator, which the host app may own, or may not have registered.
 */
const TRACEPARENT = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})(-.*)?$/

function parseTraceparent(value: string | undefined): SpanContext | undefined {
	const match = value?.trim().match(TRACEPARENT)
	// Version ff is invalid; version 00 has exactly four fields
	if (!match || match[1] === "ff" || (match[1] === "00" && match[5] !== undefined)) return undefined
	const spanContext = {
		traceId: match[2],
		spanId: match[3],
		traceFlags: Number.parseInt(match[4], 16),
		isRemote: true,
	}
	// All-zero ids are well-formed but invalid; rejecting them lets the meta tag stand in
	return isSpanContextValid(spanContext) ? spanContext : undefined
}
