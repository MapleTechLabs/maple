import { record } from "rrweb"
import { consentRevokedAt } from "../identity/consent"
import { BLOCK_SELECTOR } from "../privacy-markers"
import { clearPendingChunk, PENDING_CHUNK_KEY } from "../session/pending-chunk"
import { isReplayHalted, markActivity, markReplayHalted, nextChunkSeq } from "../session/session"
import { isJsonObject } from "../platform/json"
import { mayUseStorage } from "../platform/persistence"
import type { IngestConfig } from "../platform/transport"
import {
	type BlobPostOutcome,
	gzip,
	gzipStored,
	postSessionBlob,
	reserveKeepalive,
	warnDropped,
	type ChunkMeta,
} from "../platform/transport"
import { scrubUrl } from "../platform/url-privacy"

// rrweb event shape, read through a guard rather than typed against
// @rrweb/types across alpha releases. Only `type`, `timestamp` and `data` matter.
interface RrwebEvent {
	type: number
	timestamp: number
	data?: unknown
}

function isRrwebEvent(value: unknown): value is RrwebEvent {
	return isJsonObject(value) && typeof value.type === "number" && typeof value.timestamp === "number"
}

// rrweb enum values we rely on (stable across rrweb 1.x/2.x):
const FULL_SNAPSHOT = 2 // EventType.FullSnapshot
const META = 4 // EventType.Meta
const INCREMENTAL = 3 // EventType.IncrementalSnapshot
const SOURCE_MOUSE_INTERACTION = 2 // IncrementalSource.MouseInteraction
const MOUSE_CLICK = 2 // MouseInteractions.Click
/**
 * IncrementalSource values only a person produces: MouseMove, MouseInteraction,
 * Scroll, Input, TouchMove, Drag. Mutations, console and network are not
 * activity: a polling dashboard nobody looks at must still go idle.
 */
const USER_INPUT_SOURCES: ReadonlySet<number> = new Set([1, 2, 3, 5, 6, 12])

const FLUSH_INTERVAL_MS = 5_000
const FLUSH_BYTES = 100 * 1024
// Full DOM checkouts are synchronous rrweb work proportional to DOM size — on a
// dense dashboard a checkout is a main-thread stall, so they must stay rare.
// Playback seeks from the nearest full snapshot, so this only bounds seek cost.
const CHECKOUT_EVERY_MS = 300_000
// Hard ceiling on buffered (already-serialized) event bytes. If flushes can't
// keep up (network stall, burst), drop the batch instead of growing without
// bound — a gap in a replay beats an OOM-crashed tab.
const MAX_BUFFER_BYTES = 4 * 1024 * 1024
/** Ceiling on chunk bodies still uploading; a slow network otherwise holds every flush in memory. */
const MAX_INFLIGHT_BYTES = 2 * 1024 * 1024
/** A lost chunk is repaired with a fresh snapshot, at most this often: each one stalls the main thread. */
const MIN_RESNAPSHOT_MS = 10_000
/** Pause after ingest asks for a retry (429, 5xx), doubling per answer in a row up to the cap. */
const RETRY_BACKOFF_MS = 5_000
const MAX_RETRY_BACKOFF_MS = 60_000
/** Snapshots over the buffer cap before recording gives up on the session's DOM. */
const MAX_OVERSIZED_SNAPSHOTS = 3

function warnExhausted(sessionId: string): void {
	console.warn(
		`[maple] session replay ${sessionId} reached its maximum recorded size; recording stopped for this session (metadata and events continue)`,
	)
}

function warnOversized(sessionId: string): void {
	console.warn(
		`[maple] session replay ${sessionId} stopped: the page's DOM snapshot is larger than ${MAX_BUFFER_BYTES} bytes (metadata and events continue)`,
	)
}

// Dropped-batch warnings are rate-limited like transport failures.
let lastDropWarnAt = 0
function warnBufferDropped(bytes: number, limit: number): void {
	const now = Date.now()
	if (now - lastDropWarnAt < 30_000) return
	lastDropWarnAt = now
	console.warn(
		`[maple] session replay buffer exceeded ${limit} bytes (dropping ${bytes} buffered bytes; recording continues from the next full snapshot)`,
	)
}

/** Whether a person produced `event`: only that keeps a session from going idle. */
function isUserInput(event: RrwebEvent): boolean {
	if (event.type !== INCREMENTAL || !isJsonObject(event.data)) return false
	const source = event.data.source
	return typeof source === "number" && USER_INPUT_SOURCES.has(source)
}

function isClick(event: RrwebEvent): boolean {
	return (
		event.type === INCREMENTAL &&
		isJsonObject(event.data) &&
		event.data.source === SOURCE_MOUSE_INTERACTION &&
		event.data.type === MOUSE_CLICK
	)
}

/** The meta event carries the page URL the player shows in its address bar. */
function scrubMetaHref(event: RrwebEvent): void {
	if (event.type === META && isJsonObject(event.data) && typeof event.data.href === "string") {
		event.data.href = scrubUrl(event.data.href)
	}
}

/**
 * Whether `event` belongs to `sessionId`. User input resolves idle rotation
 * (the rotation listener stops this recorder and starts the next one, so the
 * event that discovered it is left out); anything else is kept only while the
 * session is live, so it neither revives nor rotates an idle one. The answer
 * for passive events is reused for a second: mutations arrive in bursts.
 */
function sessionGate(sessionId: string): (event: RrwebEvent) => boolean {
	let checkedAt = Number.NEGATIVE_INFINITY
	let live = true
	return (event) => {
		if (isUserInput(event)) {
			const active = markActivity("input")
			checkedAt = Number.NEGATIVE_INFINITY
			return !active || active.id === sessionId
		}
		const now = Date.now()
		if (now - checkedAt >= 1_000) {
			checkedAt = now
			const stored = markActivity("passive")
			live = stored === undefined || stored?.id === sessionId
		}
		return live
	}
}

/** Input types rrweb consults `maskInputFn` for. `select` only when masking all: it also hides the selection. */
const MASKABLE_INPUTS = [
	"color",
	"date",
	"datetime-local",
	"email",
	"month",
	"number",
	"range",
	"search",
	"tel",
	"text",
	"time",
	"url",
	"week",
	"textarea",
	"password",
	"hidden",
] as const

/** Autocomplete tokens of fields masked whatever `maskAllInputs` says. */
const SECRET_AUTOCOMPLETE = /^(cc-.+|one-time-code|current-password|new-password)$/

/**
 * Whether an input's value is a secret on any page: passwords, hidden inputs
 * (CSRF tokens, OAuth state) and card or one-time-code fields. rrweb masks
 * only `type=password` on its own, and not even hidden inputs under `maskAllInputs`.
 */
function isSecretInput(element: Element): boolean {
	const type = ("type" in element && typeof element.type === "string" ? element.type : "").toLowerCase()
	if (type === "password" || type === "hidden") return true
	if (element.hasAttribute("data-rr-is-password")) return true
	const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/)
	return autocomplete.some((token) => SECRET_AUTOCOMPLETE.test(token))
}

/** rrweb input masking: everything under `maskAllInputs`, otherwise only secrets. */
function inputMaskOptions(config: IngestConfig) {
	const maskInputOptions: Record<string, boolean> = {}
	for (const type of MASKABLE_INPUTS) maskInputOptions[type] = true
	if (config.maskAllInputs) maskInputOptions.select = true
	return {
		maskInputOptions,
		maskInputFn: (text: string, element: HTMLElement): string =>
			config.maskAllInputs || isSecretInput(element) ? "*".repeat(text.length) : text,
	}
}

/** rrweb options shared by both recorders. */
function recordOptions(config: IngestConfig) {
	return {
		...inputMaskOptions(config),
		// The README and docs advertise `data-rr-block` alongside `.rr-block`, but
		// rrweb defaults `blockSelector` to null, so the documented attribute must be passed.
		blockSelector: BLOCK_SELECTOR,
		// rrweb has no `maskAllText` flag; selecting all elements masks every text node.
		...(config.maskAllText ? { maskTextSelector: "*" } : undefined),
		// An rrweb observer that throws would surface as the host app's uncaught error.
		errorHandler: (error: unknown): boolean => {
			warnDropped("replay recording", error)
			return true
		},
		...canvasOptions(config),
	}
}

export interface Recorder {
	stop: () => void
	flush: (keepalive?: boolean) => Promise<void>
	getClickCount: () => number
}

// The chunk a page was flushing as it went away. `gzip` is async and an
// unloading document is torn down before it resolves, so the chunk waits in
// sessionStorage (this tab, this origin, like the session record) for the next
// recorder start of its session: the next page load, or this page shown again.
// A keepalive flush holds under FLUSH_BYTES of events, which bounds what is stored.
//
// An earlier page's chunk is sent only to its own session and only this young:
// consent withdrawn by a reload is never seen as a revoke, and must not be
// outlived by long. This page's own chunk has no such gap (a revoke here removes
// it), so it is sent whenever the page is shown again, under its own session
// even if that one rotated out while the page was hidden.
const MAX_PENDING_AGE_MS = 10 * 60_000
const PAGE_STARTED_AT = Date.now()
/** How long a stored chunk that found the keepalive budget full waits before its one re-attempt. */
const KEEPALIVE_RETRY_MS = 1_000

interface PendingChunk extends ChunkMeta {
	readonly body: string
	/** epoch ms; a chunk from before the last consent withdrawal is never sent. */
	readonly createdAt: number
	/** Where the recording page uploads; a page configured otherwise does not send it. */
	readonly target: string
}

function isPendingChunk(value: unknown): value is PendingChunk {
	return (
		isJsonObject(value) &&
		typeof value.sessionId === "string" &&
		typeof value.chunkSeq === "number" &&
		typeof value.isCheckpoint === "boolean" &&
		typeof value.eventCount === "number" &&
		typeof value.durationMs === "number" &&
		typeof value.body === "string" &&
		typeof value.createdAt === "number" &&
		typeof value.target === "string"
	)
}

/** Endpoint plus an FNV-1a hash of the key, so the key itself is not stored. */
function targetOf(config: IngestConfig): string {
	let hash = 0x811c9dc5
	for (const char of config.ingestKey ?? "") hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193)
	return `${config.endpoint}|${hash >>> 0}`
}

function readPending(): PendingChunk | undefined {
	if (!mayUseStorage()) return undefined
	try {
		const parsed: unknown = JSON.parse(window.sessionStorage.getItem(PENDING_CHUNK_KEY) ?? "null")
		return isPendingChunk(parsed) ? parsed : undefined
	} catch {
		return undefined
	}
}

/**
 * Keep `chunk` unless one is already waiting. False when it was not kept
 * (storage blocked or full): it is then only as durable as its upload.
 */
function storePending(chunk: PendingChunk): boolean {
	if (!mayUseStorage()) return false
	try {
		if (readPending()) return false
		window.sessionStorage.setItem(PENDING_CHUNK_KEY, JSON.stringify(chunk))
		return true
	} catch {
		return false
	}
}

/**
 * Remove the stored chunk if it is `meta`'s, reporting whether it was. Whoever
 * removes it sends it, so a seq is posted once: ingest appends an index row per POST.
 */
function takePending(meta: ChunkMeta): boolean {
	const chunk = readPending()
	return chunk?.sessionId === meta.sessionId && chunk.chunkSeq === meta.chunkSeq && clearPendingChunk()
}

/** Send the chunk an earlier flush left behind, if it is still this recorder's to send; otherwise drop it. */
function sendPendingChunk(config: IngestConfig, sessionId: string): void {
	const chunk = readPending()
	if (!chunk) return
	const sendable =
		chunk.target === targetOf(config) &&
		chunk.createdAt > consentRevokedAt() &&
		(chunk.createdAt >= PAGE_STARTED_AT ||
			(chunk.sessionId === sessionId && Date.now() - chunk.createdAt <= MAX_PENDING_AGE_MS))
	// Left stored until the POST, like the flush that stored it: a revoke can still
	// discard it, and a page gone mid-compression leaves it for the start after.
	if (sendable) void compressAndPost(config, chunk, chunk.body, false, true, chunk.createdAt)
	else clearPendingChunk()
}

/**
 * How an upload ended. Beyond ingest's answers: `"dropped"` when the chunk
 * never left (compression failed, or its session's seq is unknown here), and
 * `"handed-off"` when it is not this upload's to send any more (a later
 * recorder start sent the stored copy, or a consent revoke discarded it).
 */
type UploadOutcome = BlobPostOutcome | "dropped" | "handed-off"

/**
 * Claim a seq and upload one chunk. The seq is monotonic across reloads
 * (persisted on the session record), so a refresh continues the sequence
 * instead of overwriting the previous load's blobs.
 */
function uploadChunk(
	config: IngestConfig,
	sessionId: string,
	body: string,
	chunk: Omit<ChunkMeta, "sessionId" | "chunkSeq">,
	keepalive: boolean,
): Promise<UploadOutcome> {
	const chunkSeq = nextChunkSeq(sessionId)
	// A session whose counter this document cannot know: any seq could overwrite a stored chunk.
	if (chunkSeq === undefined) return Promise.resolve("dropped")
	const meta: ChunkMeta = { sessionId, chunkSeq, ...chunk }
	const sentNow = keepalive ? postBeforeUnload(config, meta, body) : undefined
	if (sentNow) return sentNow
	const cutAt = Date.now()
	// Stored synchronously: on a page going away nothing after the first await runs.
	const stored = keepalive && storePending({ ...meta, body, createdAt: cutAt, target: targetOf(config) })
	return compressAndPost(config, meta, body, keepalive, stored, cutAt)
}

/**
 * The most of the shared keepalive budget a chunk takes on the way out, so the
 * session row, events and spans issued alongside it keep room.
 */
const UNLOAD_CHUNK_MAX_BYTES = 24 * 1024

/**
 * Post a chunk from a page that may be going away, uncompressed, before anything
 * awaits: `CompressionStream` never resolves on a document being torn down, and
 * a stored copy only reaches ingest if this tab shows the site again. Without
 * this a visit shorter than one flush interval uploaded no recording at all.
 * Undefined when the chunk is too large, which leaves it to the stored path.
 */
function postBeforeUnload(
	config: IngestConfig,
	meta: ChunkMeta,
	body: string,
): Promise<BlobPostOutcome> | undefined {
	if (body.length > UNLOAD_CHUNK_MAX_BYTES) return undefined
	const gzipped = gzipStored(new TextEncoder().encode(body))
	if (gzipped.byteLength > UNLOAD_CHUNK_MAX_BYTES) return undefined
	const release = reserveKeepalive(true, gzipped.byteLength)
	if (!release) return undefined
	// The POST below reserves again synchronously, before anything else can run.
	release()
	return postSessionBlob(config, meta, gzipped, true)
}

async function compressAndPost(
	config: IngestConfig,
	meta: ChunkMeta,
	body: string,
	keepalive: boolean,
	stored: boolean,
	cutAt: number,
): Promise<UploadOutcome> {
	// `gzip` rejects rather than returning a truncated stream, and callers run
	// this as a floating promise: an escaping rejection would surface in the
	// host app's console as ours. Dropping the chunk is the same outcome ingest
	// produced by refusing it, minus the wasted POST.
	let gzipped: Uint8Array
	try {
		gzipped = await gzip(new TextEncoder().encode(body))
	} catch (error) {
		warnDropped("chunk compression", error)
		return "dropped"
	}
	// Consent withdrawn while this compressed: what was recorded before it is never sent.
	if (consentRevokedAt() >= cutAt) return "handed-off"
	if (stored) {
		// A request that does not get keepalive dies with the page, after the copy is
		// gone. So with no room in the shared budget right now the copy stays stored
		// and this waits once: the timer only fires on a page that is still alive,
		// where the other unload writes have finished or a plain request completes.
		// On a page that went away the copy is the next recorder start's to send.
		// With room, the probe is released at once: the POST below reserves again
		// synchronously, before anything else can run.
		if (keepalive) {
			const release = reserveKeepalive(true, gzipped.byteLength)
			if (release) release()
			else await new Promise((resolve) => setTimeout(resolve, KEEPALIVE_RETRY_MS))
		}
		// Gone: a later recorder start already sent it, or a revoke discarded it.
		if (!takePending(meta)) return "handed-off"
	}
	return postSessionBlob(config, meta, gzipped, keepalive)
}

/** Serialized events awaiting upload, with what a flush needs to know about each. */
interface EventBuffer {
	parts: string[]
	types: number[]
	timestamps: number[]
	bytes: number
}

const emptyBuffer = (): EventBuffer => ({ parts: [], types: [], timestamps: [], bytes: 0 })

function sliceBuffer(buffer: EventBuffer, start: number, end = buffer.parts.length): EventBuffer {
	const parts = buffer.parts.slice(start, end)
	return {
		parts,
		types: buffer.types.slice(start, end),
		timestamps: buffer.timestamps.slice(start, end),
		bytes: parts.reduce((sum, part) => sum + part.length, 0),
	}
}

const NOOP_RECORDER: Recorder = { stop: () => {}, flush: async () => {}, getClickCount: () => 0 }

export function startRecording(config: IngestConfig, sessionId: string): Recorder {
	sendPendingChunk(config, sessionId)
	// Ingest's size ceiling or an unrecordable DOM, met by an earlier page of the session.
	if (isReplayHalted(sessionId)) return NOOP_RECORDER
	// Events are serialized once at emit time and buffered as JSON strings, so
	// flushing is a cheap `join` instead of re-stringifying the whole buffer
	// (which stalls the main thread for hundreds of ms on full snapshots).
	let buffer = emptyBuffer()
	/** After a lost batch the stream has a gap: nothing is kept until the next snapshot's Meta. */
	let awaitingSnapshot = false
	let inflightBytes = 0
	let oversizedSnapshots = 0
	let clickCount = 0
	let stopped = false
	// Set once ingest answers 413 (the session hit its recorded-size ceiling) or
	// the DOM proved too large to snapshot: every further chunk is wasted. The
	// lifecycle (heartbeats, the `ended` row, distilled events) carries on. Before
	// this existed one long session posted a rejected chunk every 5s for the rest
	// of the page's life: 149k 413s against 14k accepted chunks for one org.
	let halted = false
	let resnapshotTimer: ReturnType<typeof setTimeout> | undefined
	let lastResnapshotAt = Number.NEGATIVE_INFINITY
	/** Uploads wait until then after ingest asked for a retry; the buffer keeps filling meanwhile. */
	let retryAt = 0
	let retriesInARow = 0

	const isHidden = (): boolean => typeof document !== "undefined" && document.visibilityState === "hidden"

	const takeResnapshot = (): void => {
		resnapshotTimer = undefined
		if (halted || !awaitingSnapshot) return
		// Uploads backed up or backing off, or nobody watching: try later rather than stall now.
		if (inflightBytes > MAX_INFLIGHT_BYTES / 2 || isHidden() || Date.now() < retryAt) {
			resnapshotTimer = setTimeout(takeResnapshot, Math.max(MIN_RESNAPSHOT_MS, retryAt - Date.now()))
			return
		}
		lastResnapshotAt = Date.now()
		try {
			record.takeFullSnapshot(true)
		} catch {
			// rrweb throws when it is not recording; capture must never throw into the page.
		}
	}

	/** Drop everything buffered and reopen the stream at a fresh snapshot, rate-limited. */
	const dropAndResnapshot = (): void => {
		buffer = emptyBuffer()
		awaitingSnapshot = true
		if (resnapshotTimer !== undefined) return
		const wait = Math.max(0, lastResnapshotAt + MIN_RESNAPSHOT_MS - Date.now())
		resnapshotTimer = setTimeout(takeResnapshot, wait)
	}

	/**
	 * A chunk did not reach ingest, so later incremental events would apply to
	 * nodes the player never built. Keep the buffer from its latest snapshot if
	 * it has one; otherwise drop it and take a fresh snapshot.
	 */
	const onChunkLost = (): void => {
		if (halted || stopped) return
		const metaAt = buffer.types.lastIndexOf(META)
		if (metaAt >= 0) buffer = sliceBuffer(buffer, metaAt)
		else dropAndResnapshot()
	}

	const halt = (warn: (sessionId: string) => void): void => {
		if (halted) return
		warn(sessionId)
		markReplayHalted(sessionId)
		haltCapture()
	}

	const flush = async (keepalive = false): Promise<void> => {
		// A stopped recorder must not upload, ever. `stop()` is the consent-revoke
		// path — it discards rather than sends — and the only thing that can still
		// call in here afterwards is a flush scheduled before the revoke landed.
		if (stopped || halted || (!keepalive && Date.now() < retryAt)) return
		// A trailing Meta waits for its FullSnapshot: a chunk never ends between the two.
		const cut = buffer.types.at(-1) === META ? buffer.parts.length - 1 : buffer.parts.length
		if (cut === 0) return
		const sending = sliceBuffer(buffer, 0, cut)
		buffer = sliceBuffer(buffer, cut)
		const body = `[${sending.parts.join(",")}]`
		if (!keepalive && inflightBytes + body.length > MAX_INFLIGHT_BYTES) {
			warnBufferDropped(body.length, MAX_INFLIGHT_BYTES)
			dropAndResnapshot()
			return
		}
		const first = sending.timestamps[0] ?? 0
		const last = sending.timestamps.at(-1) ?? first
		inflightBytes += body.length
		let outcome: UploadOutcome
		try {
			outcome = await uploadChunk(
				config,
				sessionId,
				body,
				{
					isCheckpoint: sending.types.includes(FULL_SNAPSHOT),
					eventCount: sending.parts.length,
					durationMs: Math.max(0, last - first),
				},
				keepalive,
			)
		} finally {
			inflightBytes -= body.length
		}
		if (outcome === "retry") {
			retriesInARow++
			retryAt = Date.now() + Math.min(MAX_RETRY_BACKOFF_MS, RETRY_BACKOFF_MS * 2 ** (retriesInARow - 1))
		} else if (outcome === "accepted") {
			retriesInARow = 0
		}
		// The transport already warned, and stops the channel for the rest of the page.
		if (outcome === "refused") haltCapture()
		else if (outcome === "exhausted") halt(warnExhausted)
		else if (outcome !== "accepted" && outcome !== "handed-off") onChunkLost()
	}

	// Assigned once rrweb is started below; `flush` may need it before then only
	// in theory (nothing is buffered before the first emit), so a no-op default.
	let haltCapture: () => void = () => {}
	const belongs = sessionGate(sessionId)

	const stop = record({
		emit: (event: unknown) => {
			if (!isRrwebEvent(event) || !belongs(event)) return
			scrubMetaHref(event)
			if (isClick(event)) clickCount++

			let json: string
			try {
				json = JSON.stringify(event)
			} catch {
				// Unserializable event (cycles) — playback can't use it anyway.
				return
			}

			// After a gap, incremental events are useless until the next snapshot,
			// which rrweb always opens with a Meta event.
			if (awaitingSnapshot && event.type !== META) return
			awaitingSnapshot = false

			if (buffer.bytes + json.length > MAX_BUFFER_BYTES) {
				warnBufferDropped(buffer.bytes + json.length, MAX_BUFFER_BYTES)
				if (event.type !== FULL_SNAPSHOT) {
					dropAndResnapshot()
					return
				}
				// Re-snapshotting the same DOM would emit another over-cap event, so an
				// oversized snapshot waits for the next checkout, and a few end recording.
				buffer = emptyBuffer()
				awaitingSnapshot = true
				oversizedSnapshots++
				if (oversizedSnapshots >= MAX_OVERSIZED_SNAPSHOTS) halt(warnOversized)
				return
			}

			buffer.parts.push(json)
			buffer.types.push(event.type)
			buffer.timestamps.push(event.timestamp)
			buffer.bytes += json.length
			if (buffer.bytes >= FLUSH_BYTES && event.type !== META) void flush()
		},
		...recordOptions(config),
		checkoutEveryNms: CHECKOUT_EVERY_MS,
	})

	// The periodic flush yields to idle time so it never competes with an
	// in-progress interaction; the timeout bounds staleness. Explicit flushes
	// (pagehide/unload) bypass this and run immediately. A hidden page's
	// buffer waits for it to be shown, or for the size flush.
	//
	// The handle is retained so `stop()` can cancel it: a callback already
	// queued when consent is revoked would otherwise still fire — up to the 2s
	// timeout later — and upload the buffer the revoke was meant to discard.
	let idleHandle: number | undefined
	const scheduleFlush = () => {
		if (isHidden()) return
		if (typeof requestIdleCallback === "function") {
			idleHandle = requestIdleCallback(
				() => {
					idleHandle = undefined
					void flush()
				},
				{ timeout: 2_000 },
			)
		} else {
			void flush()
		}
	}
	const flushTimer = setInterval(scheduleFlush, FLUSH_INTERVAL_MS)

	// Shared by consent revoke and halting: end rrweb, cancel pending flush work,
	// drop the buffer. Only `stopped` (revoke) also forbids the caller's later
	// explicit `flush()`s — after halting they are simply no-ops.
	haltCapture = () => {
		if (halted) return
		halted = true
		clearInterval(flushTimer)
		if (resnapshotTimer !== undefined) clearTimeout(resnapshotTimer)
		resnapshotTimer = undefined
		if (idleHandle !== undefined && typeof cancelIdleCallback === "function") {
			cancelIdleCallback(idleHandle)
			idleHandle = undefined
		}
		// Nothing may be uploaded from here on, so the buffer is dead weight —
		// and on a revoke it is dead weight holding recorded user data.
		buffer = emptyBuffer()
		stop?.()
	}

	return {
		stop: () => {
			stopped = true
			haltCapture()
		},
		flush,
		getClickCount: () => clickCount,
	}
}

/** rrweb options for `<canvas>` capture: sampled frames as WebP, off unless asked for. */
function canvasOptions(config: IngestConfig) {
	// Canvas pixels can carry text (chart labels, grids) that maskAllText cannot reach.
	if (config.maskAllText || !config.canvasFps || config.canvasFps <= 0) return undefined
	return {
		recordCanvas: true,
		sampling: { canvas: config.canvasFps },
		dataURLOptions: { type: "image/webp", quality: 0.6 },
	}
}

/**
 * Buffer mode checks out often, so the retained window stays near a minute. A
 * checkout is a full DOM snapshot, so it is skipped while hidden or when nothing changed.
 */
const BUFFER_CHECKOUT_MS = 30_000

interface Segment {
	parts: string[]
	bytes: number
	first: number
	last: number
	/** Whether the FullSnapshot followed the Meta that opened it: only then can it play. */
	playable: boolean
}

export interface BufferedRecorder {
	/** Upload what is buffered, oldest first, each segment a checkpoint chunk. */
	drain: (keepalive?: boolean) => Promise<void>
	stop: () => void
	getClickCount: () => number
}

const NOOP_BUFFERED: BufferedRecorder = { drain: async () => {}, stop: () => {}, getClickCount: () => 0 }

/**
 * Record into memory only: the segments since the second-to-last checkout, so
 * 30-60s of replay, and nothing is uploaded until `drain()`. For sessions that
 * keep a replay only when an error happens.
 */
export function startBufferedRecording(config: IngestConfig, sessionId: string): BufferedRecorder {
	if (isReplayHalted(sessionId)) return NOOP_BUFFERED
	let segments: Segment[] = []
	let bytes = 0
	let clickCount = 0
	let stopped = false
	let oversizedSnapshots = 0
	/** Incremental events since the last snapshot: an idle page needs no new one. */
	let changedSinceSnapshot = 0
	const belongs = sessionGate(sessionId)
	// Assigned once rrweb has started; an oversized first snapshot cannot reach the limit alone.
	let stopRecord: (() => void) | undefined

	const stop = (): void => {
		stopped = true
		clearInterval(checkoutTimer)
		segments = []
		bytes = 0
		stopRecord?.()
	}

	stopRecord = record({
		emit: (event: unknown) => {
			if (stopped || !isRrwebEvent(event) || !belongs(event)) return
			scrubMetaHref(event)
			if (isClick(event)) clickCount++
			let json: string
			try {
				json = JSON.stringify(event)
			} catch {
				return
			}
			// Every snapshot, first or checkout, is a Meta event then a FullSnapshot.
			if (event.type === META) {
				segments.push({
					parts: [],
					bytes: 0,
					first: event.timestamp,
					last: event.timestamp,
					playable: false,
				})
				while (segments.length > 2) bytes -= segments.shift()?.bytes ?? 0
				changedSinceSnapshot = 0
			} else if (event.type === INCREMENTAL) {
				changedSinceSnapshot++
			}
			const segment = segments.at(-1)
			// Nothing to play back before the first snapshot.
			if (!segment) return
			if (event.type === FULL_SNAPSHOT) {
				segment.playable = segment.parts.length === 1
				if (json.length > MAX_BUFFER_BYTES && ++oversizedSnapshots >= MAX_OVERSIZED_SNAPSHOTS) {
					warnOversized(sessionId)
					markReplayHalted(sessionId)
					stop()
					return
				}
			}
			segment.parts.push(json)
			segment.bytes += json.length
			segment.last = event.timestamp
			bytes += json.length
			while (bytes > MAX_BUFFER_BYTES && segments.length > 0) bytes -= segments.shift()?.bytes ?? 0
		},
		...recordOptions(config),
	})

	const checkoutTimer = setInterval(() => {
		if (stopped || changedSinceSnapshot === 0) return
		const current = segments.at(-1)
		// Hidden, a checkout waits, unless the size cap emptied the buffer or is about to.
		const urgent = current === undefined || current.bytes > MAX_BUFFER_BYTES / 2
		if (!urgent && typeof document !== "undefined" && document.visibilityState === "hidden") return
		try {
			record.takeFullSnapshot(true)
		} catch {
			// rrweb throws when it is not recording; capture must never throw into the page.
		}
	}, BUFFER_CHECKOUT_MS)

	return {
		drain: async (keepalive = false) => {
			const pending = segments.filter((segment) => segment.playable)
			segments = []
			bytes = 0
			if (stopped) return
			// Each call claims its chunk seq synchronously, so these stay ahead of
			// whatever the streaming recorder that follows uploads.
			const outcomes = await Promise.all(
				pending.map((segment) =>
					uploadChunk(
						config,
						sessionId,
						`[${segment.parts.join(",")}]`,
						{
							isCheckpoint: true,
							eventCount: segment.parts.length,
							durationMs: Math.max(0, segment.last - segment.first),
						},
						keepalive,
					),
				),
			)
			// The streaming recorder that follows would only meet the same 413.
			if (outcomes.includes("exhausted")) {
				warnExhausted(sessionId)
				markReplayHalted(sessionId)
			}
		},
		stop,
		getClickCount: () => clickCount,
	}
}
