import { stringifyWellFormed } from "./json"

/**
 * The slice of configuration the replay engine needs. Both SDKs adapt their
 * own config shapes onto this.
 */
export interface IngestConfig {
	readonly endpoint: string
	/**
	 * Sent as `Authorization: Bearer …`, and nothing else: it never decides
	 * whether a feature runs. Unset when a proxy in front of `endpoint` adds auth.
	 */
	readonly ingestKey?: string | undefined
	/** `x-maple-sdk` value — see {@link SDK_HINT_HEADER}. */
	readonly sdk: string
	readonly maskAllInputs: boolean
	readonly maskAllText: boolean
	/**
	 * Identity from `identify()`, consulted when session-event rows are built so
	 * a late `identify()` still stamps `user_id`/`group_id` on the rows that
	 * follow it — the same source the session metadata row reads.
	 */
	readonly getIdentity?: (() => EventIdentity | undefined) | undefined
	/** Record `<canvas>` content at this many frames per second. Off when unset or 0. */
	readonly canvasFps?: number | undefined
	/** Keep request and response bodies of these URLs on replay network events. */
	readonly networkBodies?: NetworkBodyOptions | undefined
}

export interface NetworkBodyOptions {
	/** Matched against the full request URL. Nothing is captured for other URLs. */
	readonly urls: ReadonlyArray<string | RegExp>
	/** Each body is cut to this many characters. */
	readonly maxLength: number
	/** Keep request bodies too. Off while inputs are masked: a form POST carries what was typed. */
	readonly requestBodies?: boolean | undefined
}

/**
 * The slice of `ResolvedIdentity` that rides on session-event rows. Declared
 * structurally so this transport layer stays free of the identity module.
 */
export interface EventIdentity {
	readonly id?: string | undefined
	readonly groupId?: string | undefined
}

/**
 * Header stamped on every request to ingest: `<sdk-name>/<version>`, e.g.
 * `maple-browser/0.3.0`. Browsers refuse to let a page set `user-agent`, so
 * without this a rejected request carried nothing that said which SDK build
 * produced it. Ingest records it as `maple.sdk` on the request span. Every
 * gateway that receives browser traffic must allow it in CORS (`apps/ingest`
 * and the CLI's local listener do) — a header the SDK always sends and
 * preflight refuses blocks the whole SDK, not just the header.
 */
export const SDK_HINT_HEADER = "x-maple-sdk"

/** `<name>/<version>` — the one shape ingest expects in `x-maple-sdk`. */
export const sdkHint = (name: string, version: string): string => `${name}/${version}`

/** Auth + identity headers shared by every ingest request. No key, no `Authorization`. */
export function ingestHeaders(config: Pick<IngestConfig, "ingestKey" | "sdk">): Record<string, string> {
	const identity = { [SDK_HINT_HEADER]: config.sdk }
	if (!config.ingestKey) return identity
	return { Authorization: `Bearer ${config.ingestKey}`, ...identity }
}

// Session writes are best-effort and must never throw into the host app, but a
// fully broken ingest endpoint should not be *silent*. Warn at most once every
// 30s so a misconfigured endpoint is visible in the console without spamming it.
// Rate-limited per call site, so a broken endpoint surfaces each distinct
// failure rather than whichever one happened to warn first. The message says
// only what failed: what happens to the data is each caller's policy.
const lastWarnAt = new Map<string, number>()
export function warnDropped(what: string, error: unknown): void {
	const now = Date.now()
	if (now - (lastWarnAt.get(what) ?? 0) < 30_000) return
	lastWarnAt.set(what, now)
	console.warn(`[maple] session ${what} failed:`, error)
}

/**
 * Combined budget for this SDK's in-flight `keepalive` bodies.
 *
 * The Fetch spec caps the *combined* in-flight keepalive body at 64 KiB per
 * document, and the browser rejects a request that would cross it. On the way
 * out several of our writes go at once (the session's final metadata row and
 * events batch, a replay chunk, either SDK's OTLP export), so the budget has
 * to be shared rather than checked per request. OTLP's own share is capped
 * ({@link OTLP_KEEPALIVE_BYTES}), which keeps room for the session rows
 * whichever is issued first.
 *
 * The budget stops short of 64 KiB for keepalive requests it cannot count,
 * the host page's own among them. That is headroom, not a guarantee.
 *
 * Over the budget a write goes out as a normal request, which the browser
 * terminates if the document unloads first: still better than a guaranteed
 * rejection.
 */
const KEEPALIVE_BUDGET_BYTES = 48 * 1024

/** The most of the budget that OTLP requests hold between them. */
export const OTLP_KEEPALIVE_BYTES = 32 * 1024

/**
 * Largest body of newest items an OTLP flush sends first from a hidden or
 * unloading document. Two signals' worth leaves about 4 KiB of OTLP's share
 * for a metrics snapshot.
 */
export const OTLP_UNLOAD_TAIL_BYTES = 14 * 1024

/** On `globalThis`: two bundled SDK copies still share one per-document allowance. */
const KEEPALIVE_KEY = "__MAPLE_KEEPALIVE_INFLIGHT__"

/** `otlpBytes` is absent on a holder created by an SDK copy that predates it. */
function keepaliveInflight(): { bytes: number; otlpBytes?: number } {
	const owner = globalThis as Record<string, unknown>
	const existing = owner[KEEPALIVE_KEY] as { bytes: number; otlpBytes?: number } | undefined
	if (existing) return existing
	const fresh = { bytes: 0 }
	owner[KEEPALIVE_KEY] = fresh
	return fresh
}

/** Keepalive bytes an OTLP request could reserve right now: its own share and the total both apply. */
export function otlpKeepaliveRoom(): number {
	const inflight = keepaliveInflight()
	return Math.max(
		0,
		Math.min(OTLP_KEEPALIVE_BYTES - (inflight.otlpBytes ?? 0), KEEPALIVE_BUDGET_BYTES - inflight.bytes),
	)
}

/**
 * Reserve `bytes` of the shared keepalive budget. Returns the release function
 * when the request may use `keepalive`, `undefined` when it must not. `otlp`
 * marks an OTLP request, which also counts against {@link OTLP_KEEPALIVE_BYTES}.
 */
export function reserveKeepalive(requested: boolean, bytes: number, otlp = false): (() => void) | undefined {
	if (!requested) return undefined
	const inflight = keepaliveInflight()
	if (bytes > (otlp ? otlpKeepaliveRoom() : KEEPALIVE_BUDGET_BYTES - inflight.bytes)) return undefined
	inflight.bytes += bytes
	if (otlp) inflight.otlpBytes = (inflight.otlpBytes ?? 0) + bytes
	let released = false
	return () => {
		if (released) return
		released = true
		inflight.bytes = Math.max(0, inflight.bytes - bytes)
		if (otlp) inflight.otlpBytes = Math.max(0, (inflight.otlpBytes ?? 0) - bytes)
	}
}

/** Keepalive bytes a session write could reserve right now. */
export function keepaliveRoom(): number {
	return Math.max(0, KEEPALIVE_BUDGET_BYTES - keepaliveInflight().bytes)
}

/** Test seam. */
export function resetKeepaliveBudgetForTests(): void {
	Object.assign(keepaliveInflight(), { bytes: 0, otlpBytes: 0 })
}

/** Body size in bytes: the keepalive limit counts bytes, and `string.length` counts UTF-16 units. */
function byteLength(body: string | Uint8Array): number {
	return typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength
}

/**
 * POST to ingest, spending the shared keepalive budget when `keepalive` is
 * requested. Resolves with the status only: the response body is cancelled
 * before the reservation is released, because the browser counts a keepalive
 * request against the per-document limit until its response body ends, not
 * until headers arrive. Rejects exactly as `fetch` does, including when
 * `signal` aborts; callers own the error policy.
 */
export async function postToIngest(
	url: string,
	headers: Record<string, string>,
	body: string | Uint8Array,
	keepalive: boolean,
	options: {
		readonly signal?: AbortSignal | undefined
		/** See {@link reserveKeepalive}. */
		readonly otlp?: boolean | undefined
	} = {},
): Promise<{ readonly ok: boolean; readonly status: number }> {
	// `length` never exceeds the byte size, so a body already past the budget is
	// not encoded only to be refused.
	const release =
		body.length > KEEPALIVE_BUDGET_BYTES
			? undefined
			: reserveKeepalive(keepalive, byteLength(body), options.otlp)
	try {
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: body as BodyInit,
			keepalive: release !== undefined,
			signal: options.signal,
		})
		// Nothing reads ingest's body; ending it here is what ends the request.
		await response.body?.cancel().catch(() => {})
		return { ok: response.ok, status: response.status }
	} finally {
		release?.()
	}
}

/**
 * Smallest well-formed gzip stream: a 10-byte header plus an 8-byte trailer.
 * Anything shorter cannot carry a complete member, whatever it contains.
 */
const GZIP_MIN_BYTES = 18

/**
 * gzip a byte buffer using the native CompressionStream (no library).
 *
 * Throws rather than returning a partial stream. The write and close promises
 * used to be discarded, so a page torn down mid-compression still resolved
 * `arrayBuffer()` — with only the bytes already flushed — and the caller posted
 * a 3-byte header stub as if it were a complete chunk. Ingest rejected those as
 * corrupt gzip; they were 82% of all replay-blob failures, overwhelmingly from
 * crawlers, which tear the page down on nearly every session.
 */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	// Safari before 16.4 and Firefox before 113: valid gzip, just not smaller.
	if (typeof CompressionStream !== "function") return gzipStored(bytes)
	const stream = new CompressionStream("gzip")
	const writer = stream.writable.getWriter()
	// Both halves are started before either is awaited: awaiting the write first
	// deadlocks once the chunk exceeds the stream's internal queue, because
	// nothing is draining the readable end yet.
	const written = writer.write(bytes as BufferSource).then(() => writer.close())
	const [buffer] = await Promise.all([new Response(stream.readable).arrayBuffer(), written])
	const out = new Uint8Array(buffer)
	if (out.length < GZIP_MIN_BYTES || out[0] !== 0x1f || out[1] !== 0x8b || out[2] !== 0x08) {
		throw new Error(`gzip produced ${out.length} bytes, not a complete gzip stream`)
	}
	return out
}

let crcTable: Uint32Array | undefined

function crc32(bytes: Uint8Array): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256)
		for (let n = 0; n < 256; n++) {
			let c = n
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
			crcTable[n] = c >>> 0
		}
	}
	let crc = 0xffffffff
	for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
	return (crc ^ 0xffffffff) >>> 0
}

/** Largest payload of one stored (uncompressed) deflate block. */
const STORED_BLOCK_BYTES = 0xffff

/**
 * gzip with stored deflate blocks: valid gzip any inflater reads, built
 * synchronously and not compressed. For a page going away, where
 * `CompressionStream` never resolves: a request has to be issued before the
 * document is torn down, and nothing after the first await runs by then.
 */
export function gzipStored(bytes: Uint8Array): Uint8Array {
	const blocks = Math.max(1, Math.ceil(bytes.length / STORED_BLOCK_BYTES))
	const out = new Uint8Array(10 + blocks * 5 + bytes.length + 8)
	const view = new DataView(out.buffer)
	// ID1 ID2 CM=deflate FLG=0 MTIME=0 XFL=0 OS=unknown
	out.set([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff])
	let at = 10
	for (let block = 0; block < blocks; block++) {
		const start = block * STORED_BLOCK_BYTES
		const length = Math.min(STORED_BLOCK_BYTES, bytes.length - start)
		out[at] = block === blocks - 1 ? 1 : 0
		view.setUint16(at + 1, length, true)
		view.setUint16(at + 3, ~length & 0xffff, true)
		out.set(bytes.subarray(start, start + length), at + 5)
		at += 5 + length
	}
	view.setUint32(at, crc32(bytes), true)
	view.setUint32(at + 4, bytes.length >>> 0, true)
	return out
}

/**
 * How ingest answered. `"retry"` (429, 5xx) may succeed later; `"refused"`
 * (401, 402, 403) will not on this page, so the channel stops; `"rejected"`
 * is any other answer, never resent; `"failed"` means no response came back,
 * so the rows may or may not have reached ingest.
 */
export type PostOutcome = "accepted" | "retry" | "refused" | "rejected" | "failed"

function outcomeOf(status: number): Exclude<PostOutcome, "failed"> {
	if (status >= 200 && status < 300) return "accepted"
	if (status === 429 || status >= 500) return "retry"
	if (status === 401 || status === 402 || status === 403) return "refused"
	return "rejected"
}

/**
 * Ingest URL and key pairs that were refused. Every later request with the
 * same key would be refused the same way, so none is sent for the rest of the
 * page; a re-init with another key starts clean.
 */
const refusedUrls = new Set<string>()

/** The URL plus an FNV-1a hash of the key, so the key itself is not kept. */
function channelOf(config: Pick<IngestConfig, "ingestKey">, url: string): string {
	let hash = 0x811c9dc5
	for (const char of config.ingestKey ?? "") hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193)
	return `${url}|${hash >>> 0}`
}

const isRefused = (config: Pick<IngestConfig, "ingestKey">, url: string): boolean =>
	refusedUrls.has(channelOf(config, url))

function refuse(config: Pick<IngestConfig, "ingestKey">, url: string, status: number): void {
	const channel = channelOf(config, url)
	if (refusedUrls.has(channel)) return
	refusedUrls.add(channel)
	console.warn(`[maple] ingest refused ${url} (HTTP ${status}); nothing more is sent there from this page`)
}

/** Test seam. */
export function resetRefusedChannelsForTests(): void {
	refusedUrls.clear()
}

/** POST one body, mapping the answer to a {@link PostOutcome}. Never throws. */
async function postNdjson(
	config: IngestConfig,
	url: string,
	body: string,
	keepalive: boolean,
	what: string,
): Promise<PostOutcome> {
	try {
		const response = await postToIngest(
			url,
			{ ...ingestHeaders(config), "content-type": "application/x-ndjson" },
			body,
			keepalive,
		)
		const outcome = outcomeOf(response.status)
		if (outcome === "refused") refuse(config, url, response.status)
		return outcome
	} catch (error) {
		warnDropped(what, error)
		return "failed"
	}
}

/** POST session metadata (NDJSON, single row). `keepalive` for the final unload write. */
export async function postSessionMeta(
	config: IngestConfig,
	row: Record<string, unknown>,
	keepalive = false,
): Promise<void> {
	const url = `${config.endpoint}/v1/sessionReplays/meta`
	if (isRefused(config, url)) return
	// Replay is best-effort; never throws into the host app.
	await postNdjson(config, url, `${stringifyWellFormed(row)}\n`, keepalive, "metadata POST")
}

/** Worst first: what a caller acts on when a batch went out in parts. */
const OUTCOME_RANK = {
	refused: 0,
	failed: 1,
	retry: 2,
	rejected: 3,
	accepted: 4,
} satisfies Record<PostOutcome, number>

/**
 * Split NDJSON lines for a page going away: the oldest that fit the keepalive
 * room left, measured on the serialized bytes, and the rest as a plain request
 * that only survives if the page does. One body over the room lost all of it.
 */
function keepaliveBodies(lines: ReadonlyArray<string>): Array<{ body: string; keepalive: boolean }> {
	const encoder = new TextEncoder()
	let room = keepaliveRoom()
	let fits = 0
	for (const line of lines) {
		const size = encoder.encode(line).byteLength
		if (size > room) break
		room -= size
		fits++
	}
	const bodies = [
		{ body: lines.slice(0, fits).join(""), keepalive: true },
		{ body: lines.slice(fits).join(""), keepalive: false },
	]
	return bodies.filter(({ body }) => body.length > 0)
}

/**
 * POST distilled session events (NDJSON, one row per event). Never throws.
 * A keepalive batch larger than the room left goes out in two parts, and the
 * worst of their outcomes is returned.
 */
export async function postSessionEvents(
	config: IngestConfig,
	rows: ReadonlyArray<Record<string, unknown>>,
	keepalive = false,
): Promise<PostOutcome> {
	if (rows.length === 0) return "accepted"
	const url = `${config.endpoint}/v1/sessionEvents`
	if (isRefused(config, url)) return "refused"
	const lines = rows.map((row) => `${stringifyWellFormed(row)}\n`)
	const bodies = keepalive ? keepaliveBodies(lines) : [{ body: lines.join(""), keepalive: false }]
	// Issued together, without awaiting in between: each reserves keepalive room as it starts.
	const outcomes = await Promise.all(
		bodies.map((part) => postNdjson(config, url, part.body, part.keepalive, "events POST")),
	)
	return outcomes.reduce((worst, outcome) =>
		OUTCOME_RANK[outcome] < OUTCOME_RANK[worst] ? outcome : worst,
	)
}

export interface ChunkMeta {
	readonly sessionId: string
	readonly chunkSeq: number
	readonly isCheckpoint: boolean
	readonly eventCount: number
	readonly durationMs: number
}

/**
 * How ingest answered a chunk upload. `"exhausted"` is the 413 ingest returns
 * once a session has hit its recorded-size ceiling; every later chunk of that
 * session gets the same answer, so the recorder must stop uploading rather than
 * pay for a rejected POST every flush for the rest of the page's life. The
 * others are as for {@link PostOutcome}.
 */
export type BlobPostOutcome = "accepted" | "retry" | "refused" | "rejected" | "exhausted" | "failed"

const SESSION_EXHAUSTED_STATUS = 413

/** POST a gzipped rrweb event chunk. */
export async function postSessionBlob(
	config: IngestConfig,
	meta: ChunkMeta,
	gzipped: Uint8Array,
	keepalive = false,
): Promise<BlobPostOutcome> {
	const url = `${config.endpoint}/v1/sessionReplays/blob`
	if (isRefused(config, url)) return "refused"
	try {
		const response = await postToIngest(
			url,
			{
				...ingestHeaders(config),
				"content-type": "application/octet-stream",
				"x-maple-session-id": meta.sessionId,
				"x-maple-chunk-seq": String(meta.chunkSeq),
				"x-maple-is-checkpoint": meta.isCheckpoint ? "1" : "0",
				"x-maple-event-count": String(meta.eventCount),
				"x-maple-duration-ms": String(meta.durationMs),
			},
			gzipped,
			keepalive,
		)
		if (response.status === SESSION_EXHAUSTED_STATUS) return "exhausted"
		const outcome = outcomeOf(response.status)
		if (outcome === "refused") refuse(config, url, response.status)
		return outcome
	} catch (error) {
		// Best-effort.
		warnDropped("blob PUT", error)
		return "failed"
	}
}
