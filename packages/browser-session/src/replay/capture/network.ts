import { type Emit, safeEmit } from "../../capture/shared"
import { activeTraceId, withStartedTraceId } from "../../events/trace-id"
import { patchMethod } from "../../capture/patch"
import type { NetworkBodyOptions } from "../../platform/transport"
import { truncateText } from "../../platform/text"

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
		// Plain-JS config can hand us anything; a bad entry must not throw inside the host's fetch.
		if (!(pattern instanceof RegExp)) return false
		// A `g`/`y` regex is stateful: `test` advances `lastIndex`, so reset it first.
		pattern.lastIndex = 0
		return pattern.test(url)
	})

/**
 * JSON keys and form fields whose values are credentials whatever the app
 * calls them: tokens, secrets, passwords, API keys, cookies, auth headers.
 */
const CREDENTIAL_KEY =
	/token|secret|pass(word|wd|phrase|code)|(^|[-_])(pwd|pass)([-_]|$)|authori[sz]ation|(^|[-_])auth([-_]|$)|api[-_]?key|cookie|credential|private[-_]?key|access[-_]?key|(^|[-_])(otp|cvv|cvc|ssn)([-_]|$)|card[-_]?number/i
/** A JSON member: a string key and its string (possibly cut off) or bare value. */
const JSON_MEMBER = /"((?:[^"\\]|\\.)*)"(\s*:\s*)("(?:[^"\\]|\\.)*"?|[^\s,}\]"{[]+)/g
/** A form field: `key=value`, at the start or after `&`. */
const FORM_FIELD = /(^|&)([^=&]*)=([^&]*)/g
const REDACTED = "[REDACTED]"

/**
 * Blank the values of credential-looking keys in a JSON or form body. Works on
 * a prefix too: a body cut mid-value still loses the value.
 */
function redactCredentials(body: string): string {
	const json = redactJson(body)
	if (json !== undefined) return json
	return body
		.replace(JSON_MEMBER, (member, key: string, colon: string) =>
			CREDENTIAL_KEY.test(key) ? `"${key}"${colon}"${REDACTED}"` : member,
		)
		.replace(FORM_FIELD, (field, lead: string, key: string) =>
			CREDENTIAL_KEY.test(safeDecode(key)) ? `${lead}${key}=${REDACTED}` : field,
		)
}

/**
 * A whole JSON body, walked: a credential key loses its value even when that
 * value is an object or array, which the member regex cannot see into.
 */
function redactJson(body: string): string | undefined {
	// Past this the regex pass is cheaper than a parse and re-serialize on the main thread.
	if (body.length > 1024 * 1024) return undefined
	const start = body.trimStart()[0]
	if (start !== "{" && start !== "[") return undefined
	try {
		return JSON.stringify(
			JSON.parse(body, (key, value: unknown) =>
				key !== "" && CREDENTIAL_KEY.test(key) ? REDACTED : value,
			),
		)
	} catch {
		return undefined
	}
}

function safeDecode(text: string): string {
	try {
		return decodeURIComponent(text.replace(/\+/g, " "))
	} catch {
		return text
	}
}

const cut = (text: string, maxLength: number): string => truncateText(redactCredentials(text), maxLength, "…")

/** What a live network capture reports to; undefined once it is torn down. */
interface NetworkHooks {
	readonly record: (
		url: string,
		method: string,
		status: number,
		start: number,
		traceId: string | undefined,
		error?: string,
		extra?: Record<string, string>,
		end?: number,
	) => void
	readonly wantsBody: (url: string) => boolean
	readonly bodyAttrs: (request: string | undefined, response: string | undefined) => Record<string, string>
	readonly maxLength: number
}

/**
 * Capture fetch + XHR requests as session events, tagged with the active trace
 * id so each request links to its backend trace. `ignoreUrl` skips Maple's own
 * ingest endpoints (otherwise capturing the session-events POST would loop).
 * `bodies`, when set, keeps text request/response bodies of the URLs it lists,
 * with credential-looking values blanked.
 *
 * Teardown leaves a wrapper something else installed on top of in place, inert
 * (see `patchMethod`), so an app's own interceptor keeps working.
 */
export function installNetworkCapture(
	emit: Emit,
	ignoreUrl: (url: string) => boolean,
	bodies?: NetworkBodyOptions,
): () => void {
	const hooks: NetworkHooks = {
		wantsBody: (url) => bodies !== undefined && matchesUrl(absoluteUrl(url), bodies.urls),
		bodyAttrs: (request, response) => ({
			...(request && bodies?.requestBodies !== false
				? { "request.body": cut(request, bodies?.maxLength ?? 0) }
				: undefined),
			...(response && bodies ? { "response.body": cut(response, bodies.maxLength) } : undefined),
		}),
		maxLength: bodies?.maxLength ?? 0,
		record: (url, method, status, start, traceId, error, extra, end = performance.now()) => {
			if (ignoreUrl(url)) return
			const attrs = { ...extra, ...(error ? { error } : undefined) }
			safeEmit(emit, {
				type: "network",
				net: { method, url, status, durationMs: Math.round(end - start) },
				traceId,
				...(Object.keys(attrs).length > 0 ? { attrs } : undefined),
			})
		},
	}
	if (typeof window === "undefined") return () => {}
	const uninstall: Array<() => void> = []
	if (typeof window.fetch === "function") uninstall.push(patchMethod(window, "fetch", hooks, wrapFetch))
	const XHR = window.XMLHttpRequest
	if (XHR && typeof XHR.prototype.open === "function" && typeof XHR.prototype.send === "function") {
		uninstall.push(patchMethod(XHR.prototype, "open", hooks, wrapXhrOpen))
		uninstall.push(patchMethod(XHR.prototype, "send", hooks, wrapXhrSend))
	}
	return () => {
		for (const off of uninstall) off()
	}
}

function wrapFetch(original: typeof fetch, hooks: () => NetworkHooks | undefined): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const live = hooks()
		if (!live) return original(input, init)
		const url = requestUrl(input)
		const method = requestMethod(input, init)
		const ambientTraceId = activeTraceId()
		const start = performance.now()
		let traceId = ambientTraceId
		try {
			// Synchronous up to here, so a fetch instrumentation wrapped inside
			// this one starts its span within the slot.
			const call = withStartedTraceId(() => original(input, init))
			traceId = call.traceId ?? ambientTraceId
			const res = await call.result
			if (!live.wantsBody(url)) {
				live.record(url, method, res.status, start, traceId)
				return res
			}
			// Read a clone in the background: the app gets its response untouched and unwaited.
			const requestBody = typeof init?.body === "string" ? init.body : undefined
			const done = performance.now()
			const contentType = res.headers.get("content-type") ?? ""
			void (
				isReadableText(contentType)
					? readPrefix(res.clone(), live.maxLength)
					: Promise.resolve(undefined)
			)
				.catch(() => undefined)
				.then((responseBody) =>
					live.record(
						url,
						method,
						res.status,
						start,
						traceId,
						undefined,
						live.bodyAttrs(requestBody, responseBody),
						done,
					),
				)
			return res
		} catch (error) {
			live.record(url, method, 0, start, traceId, String(error))
			throw error
		}
	}
}

// XMLHttpRequest: `open` captures method and url, `send` times and observes.
function wrapXhrOpen(
	original: XMLHttpRequest["open"],
	hooks: () => NetworkHooks | undefined,
): XMLHttpRequest["open"] {
	return function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
		const call = (): void => original.apply(this, [method, url, ...rest] as never)
		if (!hooks()) return call()
		const meta = xhrMeta(this)
		meta.__mapleMethod = String(method).toUpperCase()
		// `String`, as the native method coerces: `null` or an object with its own `toString` are valid.
		meta.__mapleUrl = String(url)
		// Some XHR instrumentations start their span in `open`, not `send`.
		const started = withStartedTraceId(call)
		meta.__mapleTraceId = started.traceId
		return started.result
	}
}

function wrapXhrSend(
	original: XMLHttpRequest["send"],
	hooks: () => NetworkHooks | undefined,
): XMLHttpRequest["send"] {
	return function (this: XMLHttpRequest, ...args: unknown[]) {
		const live = hooks()
		if (!live) return original.apply(this, args as never)
		const meta = xhrMeta(this)
		const start = performance.now()
		let traceId = meta.__mapleTraceId ?? activeTraceId()
		const url = meta.__mapleUrl ?? ""
		const requestBody = typeof args[0] === "string" ? args[0] : undefined
		this.addEventListener("loadend", () => {
			const extra = live.wantsBody(url) ? live.bodyAttrs(requestBody, xhrResponseText(this)) : undefined
			live.record(url, meta.__mapleMethod ?? "GET", this.status, start, traceId, undefined, extra)
		})
		const call = withStartedTraceId(() => original.apply(this, args as never))
		traceId = call.traceId ?? traceId
		return call.result
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

/** The request with the fields capture keeps on it; all optional, so any request is one. */
const xhrMeta = (xhr: XMLHttpRequest): XhrMeta => xhr

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input
	if (input instanceof URL) return input.href
	return input.url
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
	const m = init?.method ?? (typeof input === "object" && "method" in input ? input.method : undefined)
	return (m ?? "GET").toUpperCase()
}
