import { type Emit, safeEmit } from "../../capture/shared"
import { activeTraceId, withStartedTraceId } from "../../events/trace-id"
import type { NetworkBodyOptions } from "../../platform/transport"

/** Only text is worth keeping; a body that is an image or a stream is not read. */
const TEXT_CONTENT = /^(text\/|application\/(json|xml|x-www-form-urlencoded|[\w.+-]+\+(json|xml)))/i
/** Text, but never finished: reading a clone would hold the connection open after the app cancels. */
const STREAMING_CONTENT = /^text\/event-stream/i
/** A slow body is given up on rather than kept in memory for as long as it trickles. */
const BODY_READ_TIMEOUT_MS = 5_000

const isReadableText = (contentType: string): boolean =>
	TEXT_CONTENT.test(contentType) && !STREAMING_CONTENT.test(contentType)

/** Patterns match the full URL, as documented: a relative `fetch("/api")` is resolved against the page. */
const absoluteUrl = (url: string): string => {
	try {
		return new URL(url, location.href).href
	} catch {
		return url
	}
}

const matchesUrl = (url: string, patterns: ReadonlyArray<string | RegExp>): boolean =>
	patterns.some((pattern) => {
		if (typeof pattern === "string") return url.includes(pattern)
		// A `g`/`y` regex is stateful: `test` advances `lastIndex`, so reset it first.
		pattern.lastIndex = 0
		return pattern.test(url)
	})

const cut = (text: string, maxLength: number): string =>
	text.length > maxLength ? `${text.slice(0, maxLength)}…` : text

/**
 * Capture fetch + XHR requests as session events, tagged with the active trace
 * id so each request links to its backend trace. `ignoreUrl` skips Maple's own
 * ingest endpoints (otherwise capturing the session-events POST would loop).
 * `bodies`, when set, keeps text request/response bodies of the URLs it lists.
 */
export function installNetworkCapture(
	emit: Emit,
	ignoreUrl: (url: string) => boolean,
	bodies?: NetworkBodyOptions,
): () => void {
	const wantsBody = (url: string): boolean =>
		bodies !== undefined && matchesUrl(absoluteUrl(url), bodies.urls)
	const bodyAttrs = (
		request: string | undefined,
		response: string | undefined,
	): Record<string, string> => ({
		...(request && bodies?.requestBodies !== false
			? { "request.body": cut(request, bodies?.maxLength ?? 0) }
			: undefined),
		...(response && bodies ? { "response.body": cut(response, bodies.maxLength) } : undefined),
	})
	const origFetch = typeof window !== "undefined" ? window.fetch : undefined

	if (origFetch) {
		window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = requestUrl(input)
			const method = requestMethod(input, init)
			const ambientTraceId = activeTraceId()
			const start = performance.now()
			let traceId = ambientTraceId
			try {
				// Synchronous up to here, so a fetch instrumentation wrapped inside
				// this one starts its span within the slot.
				const call = withStartedTraceId(() => origFetch(input, init))
				traceId = call.traceId ?? ambientTraceId
				const res = await call.result
				if (!wantsBody(url)) {
					record(url, method, res.status, start, traceId)
					return res
				}
				// Read a clone in the background: the app gets its response untouched and unwaited.
				const requestBody = typeof init?.body === "string" ? init.body : undefined
				const done = performance.now()
				const contentType = res.headers.get("content-type") ?? ""
				void (
					isReadableText(contentType)
						? readPrefix(res.clone(), bodies?.maxLength ?? 0)
						: Promise.resolve(undefined)
				)
					.catch(() => undefined)
					.then((responseBody) =>
						record(
							url,
							method,
							res.status,
							start,
							traceId,
							undefined,
							bodyAttrs(requestBody, responseBody),
							done,
						),
					)
				return res
			} catch (error) {
				record(url, method, 0, start, traceId, String(error))
				throw error
			}
		}
	}

	const record = (
		url: string,
		method: string,
		status: number,
		start: number,
		traceId: string | undefined,
		error?: string,
		extra?: Record<string, string>,
		end = performance.now(),
	): void => {
		if (ignoreUrl(url)) return
		const attrs = { ...extra, ...(error ? { error } : undefined) }
		safeEmit(emit, {
			type: "network",
			net: { method, url, status, durationMs: Math.round(end - start) },
			traceId,
			...(Object.keys(attrs).length > 0 ? { attrs } : undefined),
		})
	}

	// XMLHttpRequest — patch open (to capture method/url) + send (to time + observe).
	const XHR = typeof window !== "undefined" ? window.XMLHttpRequest : undefined
	const origOpen = XHR?.prototype.open
	const origSend = XHR?.prototype.send
	if (XHR && origOpen && origSend) {
		XHR.prototype.open = function (
			this: XMLHttpRequest,
			method: string,
			url: string | URL,
			...rest: unknown[]
		) {
			;(this as XhrMeta).__mapleMethod = String(method).toUpperCase()
			;(this as XhrMeta).__mapleUrl = typeof url === "string" ? url : url.href
			// Some XHR instrumentations start their span in `open`, not `send`.
			const call = withStartedTraceId(() => origOpen.apply(this, [method, url, ...rest] as never))
			;(this as XhrMeta).__mapleTraceId = call.traceId
			return call.result
		}
		XHR.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
			const meta = this as XhrMeta
			const start = performance.now()
			let traceId = meta.__mapleTraceId ?? activeTraceId()
			const url = meta.__mapleUrl ?? ""
			const requestBody = typeof args[0] === "string" ? args[0] : undefined
			this.addEventListener("loadend", () => {
				const extra = wantsBody(url) ? bodyAttrs(requestBody, xhrResponseText(this)) : undefined
				record(url, meta.__mapleMethod ?? "GET", this.status, start, traceId, undefined, extra)
			})
			const call = withStartedTraceId(() => origSend.apply(this, args as never))
			traceId = call.traceId ?? traceId
			return call.result
		}
	}

	return () => {
		if (origFetch) window.fetch = origFetch
		if (XHR && origOpen) XHR.prototype.open = origOpen
		if (XHR && origSend) XHR.prototype.send = origSend
	}
}

/**
 * Up to `maxLength` characters of a response body (one more, so `cut` marks it
 * cut), then the stream is cancelled: a large payload is never read in full.
 */
async function readPrefix(response: Response, maxLength: number): Promise<string | undefined> {
	const reader = response.body?.getReader()
	if (!reader) return undefined
	const decoder = new TextDecoder()
	let text = ""
	const deadline = Date.now() + BODY_READ_TIMEOUT_MS
	while (text.length <= maxLength) {
		const remaining = deadline - Date.now()
		const chunk = remaining > 0 ? await readWithin(reader, remaining) : undefined
		if (!chunk) {
			// Timed out: keep what arrived and release the connection.
			void reader.cancel().catch(() => {})
			return text || undefined
		}
		if (chunk.done) return text + decoder.decode()
		text += decoder.decode(chunk.value, { stream: true })
	}
	void reader.cancel().catch(() => {})
	return text
}

/** One read, or `undefined` if nothing arrives within `ms`. */
function readWithin(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	ms: number,
): Promise<ReadableStreamReadResult<Uint8Array> | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), ms)
	})
	return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer))
}

/** A text or JSON XHR response, as text; the browser already holds it, so this only slices. */
function xhrResponseText(xhr: XMLHttpRequest): string | undefined {
	if (!isReadableText(xhr.getResponseHeader("content-type") ?? "")) return undefined
	if (xhr.responseType === "" || xhr.responseType === "text") return xhr.responseText
	if (xhr.responseType === "json") {
		try {
			return JSON.stringify(xhr.response)
		} catch {
			return undefined
		}
	}
	return undefined
}

interface XhrMeta extends XMLHttpRequest {
	__mapleMethod?: string
	__mapleUrl?: string
	__mapleTraceId?: string | undefined
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input
	if (input instanceof URL) return input.href
	return input.url
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
	const m = init?.method ?? (typeof input === "object" && "method" in input ? input.method : undefined)
	return (m ?? "GET").toUpperCase()
}
