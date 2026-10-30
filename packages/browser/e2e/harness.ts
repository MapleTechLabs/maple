// SAFETY-FILE: JSON parsed here is what the SDK under test sent to the fake ingest.
// End-to-end harness: a fake ingest that records and decodes every request the
// SDK makes, a static server for the fixture app (built against `dist/`), and
// a real Chromium driven through Playwright.
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { readFile } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import { gunzipSync } from "node:zlib"
import { type Browser, chromium, type Page } from "playwright"

export interface IngestRequest {
	readonly path: string
	readonly headers: IncomingMessage["headers"]
	readonly body: Buffer
	readonly at: number
}

/** What the fake ingest answers for a path; defaults to 200. */
export type Responder = (request: IngestRequest) => number

export interface Ingest {
	readonly url: string
	readonly requests: IngestRequest[]
	respond: Responder
	close: () => Promise<void>
}

const listen = (server: Server): Promise<string> =>
	new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo
			resolve(`http://127.0.0.1:${port}`)
		})
	})

const closeServer = (server: Server): Promise<void> =>
	new Promise((resolve) => {
		server.closeAllConnections()
		server.close(() => resolve())
	})

/** A cross-origin ingest, as in production: every POST goes through CORS. */
export async function startIngest(): Promise<Ingest> {
	const requests: IngestRequest[] = []
	const ingest = { requests, respond: (() => 200) as Responder }
	const server = createServer((req, res) => {
		res.setHeader("access-control-allow-origin", req.headers.origin ?? "*")
		res.setHeader("access-control-allow-methods", "POST, OPTIONS")
		res.setHeader("access-control-allow-headers", req.headers["access-control-request-headers"] ?? "*")
		res.setHeader("access-control-max-age", "600")
		if (req.method === "OPTIONS") {
			res.writeHead(204).end()
			return
		}
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", () => {
			const request = {
				path: (req.url ?? "/").split("?")[0] ?? "/",
				headers: req.headers,
				body: Buffer.concat(chunks),
				at: Date.now(),
			}
			requests.push(request)
			res.writeHead(ingest.respond(request), { "content-type": "application/json" }).end("{}")
		})
	})
	const url = await listen(server)
	return Object.assign(ingest, { url, close: () => closeServer(server) })
}

const CONTENT_TYPES = new Map([
	[".html", "text/html; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".css", "text/css; charset=utf-8"],
])

/** Serves the built fixture app, plus `/api/*` endpoints the app can call. */
export async function startApp(root: string): Promise<{
	url: string
	/** `/api/*` calls the app made, with the headers they arrived with. */
	apiRequests: Array<{ readonly path: string; readonly headers: IncomingMessage["headers"] }>
	close: () => Promise<void>
}> {
	const apiRequests: Array<{ path: string; headers: IncomingMessage["headers"] }> = []
	const server = createServer((req, res) => {
		const path = (req.url ?? "/").split("?")[0] ?? "/"
		if (path.startsWith("/api/")) {
			apiRequests.push({ path, headers: req.headers })
			const status = Number(path.split("/")[2]) || 200
			res.writeHead(status, { "content-type": "application/json" }).end(`{"path":"${path}"}`)
			return
		}
		const file = normalize(join(root, path === "/" ? "index.html" : path))
		if (!file.startsWith(root)) {
			res.writeHead(403).end()
			return
		}
		readFile(file).then(
			(data) =>
				res
					.writeHead(200, {
						"content-type": CONTENT_TYPES.get(extname(file)) ?? "application/octet-stream",
					})
					.end(data),
			() => res.writeHead(404).end(),
		)
	})
	const url = await listen(server)
	return { url, apiRequests, close: () => closeServer(server) }
}

export const launchBrowser = (): Promise<Browser> => chromium.launch({ headless: true })

/** Poll until `read` returns a value, or fail with what was last seen. */
export async function waitFor<T>(
	describe: string,
	read: () => T | undefined | false,
	timeoutMs = 10_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const value = read()
		if (value !== undefined && value !== false) return value
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe}`)
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
}

// ---- decoding what the SDK sent -------------------------------------------

type AnyValue = {
	readonly stringValue?: string
	readonly intValue?: string | number
	readonly doubleValue?: number
	readonly boolValue?: boolean
	readonly arrayValue?: { readonly values?: ReadonlyArray<AnyValue> }
}
type KeyValue = { readonly key: string; readonly value: AnyValue }

/** An OTLP attribute value as the assertions read it. */
export type AttributeValue = string | number | boolean | undefined | ReadonlyArray<AttributeValue>

const valueOf = (value: AnyValue): AttributeValue =>
	value.stringValue ??
	(value.intValue !== undefined ? Number(value.intValue) : undefined) ??
	value.doubleValue ??
	value.boolValue ??
	value.arrayValue?.values?.map(valueOf)

const attributesOf = (list: ReadonlyArray<KeyValue> | undefined): Record<string, AttributeValue> =>
	Object.fromEntries((list ?? []).map((kv) => [kv.key, valueOf(kv.value)]))

export interface DecodedSpan {
	readonly name: string
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string | undefined
	readonly kind: number
	readonly status: { readonly code?: number; readonly message?: string }
	readonly attributes: Record<string, AttributeValue>
	readonly events: ReadonlyArray<{
		readonly name: string
		readonly attributes: Record<string, AttributeValue>
	}>
	readonly resource: Record<string, AttributeValue>
}

interface OtlpSpan {
	readonly name: string
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId?: string
	readonly kind: number
	readonly status?: { readonly code?: number; readonly message?: string }
	readonly attributes?: ReadonlyArray<KeyValue>
	readonly events?: ReadonlyArray<{ readonly name: string; readonly attributes?: ReadonlyArray<KeyValue> }>
}

const bodyText = (request: IngestRequest): string =>
	request.headers["content-encoding"] === "gzip"
		? gunzipSync(request.body).toString("utf8")
		: request.body.toString("utf8")

export const spansOf = (requests: ReadonlyArray<IngestRequest>): DecodedSpan[] =>
	requests
		.filter((request) => request.path === "/v1/traces")
		.flatMap((request) => {
			const body: {
				resourceSpans?: ReadonlyArray<{
					resource?: { attributes?: ReadonlyArray<KeyValue> }
					scopeSpans: ReadonlyArray<{ spans: ReadonlyArray<OtlpSpan> }>
				}>
			} = JSON.parse(bodyText(request))
			return (body.resourceSpans ?? []).flatMap((resourceSpans) =>
				resourceSpans.scopeSpans.flatMap((scope) =>
					scope.spans.map((span) => ({
						name: span.name,
						traceId: span.traceId,
						spanId: span.spanId,
						parentSpanId: span.parentSpanId || undefined,
						kind: span.kind,
						status: span.status ?? {},
						attributes: attributesOf(span.attributes),
						events: (span.events ?? []).map((event) => ({
							name: event.name,
							attributes: attributesOf(event.attributes),
						})),
						resource: attributesOf(resourceSpans.resource?.attributes),
					})),
				),
			)
		})

export interface DecodedLog {
	readonly body: AttributeValue
	readonly severityText: string | undefined
	readonly attributes: Record<string, AttributeValue>
	readonly traceId: string | undefined
}

export const logsOf = (requests: ReadonlyArray<IngestRequest>): DecodedLog[] =>
	requests
		.filter((request) => request.path === "/v1/logs")
		.flatMap((request) => {
			const body: {
				resourceLogs?: ReadonlyArray<{
					scopeLogs: ReadonlyArray<{
						logRecords: ReadonlyArray<{
							body?: AnyValue
							severityText?: string
							attributes?: ReadonlyArray<KeyValue>
							traceId?: string
						}>
					}>
				}>
			} = JSON.parse(bodyText(request))
			return (body.resourceLogs ?? []).flatMap((resource) =>
				resource.scopeLogs.flatMap((scope) =>
					scope.logRecords.map((record) => ({
						body: record.body ? valueOf(record.body) : undefined,
						severityText: record.severityText,
						attributes: attributesOf(record.attributes),
						traceId: record.traceId || undefined,
					})),
				),
			)
		})

/** rrweb event types the assertions care about. */
export const RRWEB = {
	DomContentLoaded: 0,
	Load: 1,
	FullSnapshot: 2,
	Incremental: 3,
	Meta: 4,
	Custom: 5,
} as const

export interface RrwebEvent {
	readonly type: number
	readonly timestamp: number
	readonly data: unknown
}

export interface ReplayChunk {
	readonly sessionId: string
	readonly seq: number
	readonly isCheckpoint: boolean
	readonly eventCount: number
	readonly events: ReadonlyArray<RrwebEvent>
	/** The decompressed JSON, for "never appears anywhere" privacy checks. */
	readonly raw: string
}

export const replayChunksOf = (requests: ReadonlyArray<IngestRequest>): ReplayChunk[] =>
	requests
		.filter((request) => request.path === "/v1/sessionReplays/blob")
		.map((request) => {
			const raw = gunzipSync(request.body).toString("utf8")
			return {
				sessionId: String(request.headers["x-maple-session-id"]),
				seq: Number(request.headers["x-maple-chunk-seq"]),
				isCheckpoint: request.headers["x-maple-is-checkpoint"] === "1",
				eventCount: Number(request.headers["x-maple-event-count"]),
				events: JSON.parse(raw),
				raw,
			}
		})

const ndjsonOf = (requests: ReadonlyArray<IngestRequest>, path: string): Record<string, unknown>[] =>
	requests
		.filter((request) => request.path === path)
		.flatMap((request) =>
			bodyText(request)
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line)),
		)

export const metaRowsOf = (requests: ReadonlyArray<IngestRequest>) =>
	ndjsonOf(requests, "/v1/sessionReplays/meta")

export const sessionEventsOf = (requests: ReadonlyArray<IngestRequest>) =>
	ndjsonOf(requests, "/v1/sessionEvents")

/** Every byte the SDK sent anywhere, decoded, for privacy assertions. */
export const everythingSent = (requests: ReadonlyArray<IngestRequest>): string =>
	requests
		.map((request) =>
			request.path === "/v1/sessionReplays/blob"
				? gunzipSync(request.body).toString("utf8")
				: bodyText(request),
		)
		.join("\n")

/**
 * Headless Chromium reports `HeadlessChrome/`, which the SDK routes to a
 * metadata-only crawler session, so the suite browses as a desktop Chrome.
 */
export const DESKTOP_CHROME_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"

/** Open the fixture app with a config, collecting page errors the host app would see. */
export async function openApp(
	browser: Browser,
	appUrl: string,
	config: Record<string, unknown>,
	options: { readonly path?: string; readonly userAgent?: string } = {},
): Promise<{ page: Page; pageErrors: string[] }> {
	const path = options.path ?? "/"
	const context = await browser.newContext({ userAgent: options.userAgent ?? DESKTOP_CHROME_UA })
	const page = await context.newPage()
	const pageErrors: string[] = []
	page.on("pageerror", (error) => pageErrors.push(error.message))
	await page.goto(`${appUrl}${path}?maple=${encodeURIComponent(JSON.stringify(config))}`)
	return { page, pageErrors }
}
