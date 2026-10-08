import { record } from "rrweb"
import { consentRevokedAt } from "../identity/consent"
import { BLOCK_SELECTOR } from "../privacy-markers"
import { clearPendingChunk, PENDING_CHUNK_KEY } from "../session/pending-chunk"
import { markActivity, nextChunkSeq } from "../session/session"
import { isJsonObject } from "../platform/json"
import type { IngestConfig } from "../platform/transport"
import {
	type BlobPostOutcome,
	gzip,
	postSessionBlob,
	reserveKeepalive,
	warnDropped,
	type ChunkMeta,
} from "../platform/transport"
import { scrubUrl } from "../platform/url-privacy"

// rrweb event shape — typed loosely to avoid coupling to @rrweb/types across
// alpha releases. We only read `type`, `timestamp`, and incremental `data`.
interface RrwebEvent {
	type: number
	timestamp: number
	data?: { source?: number; type?: number; href?: unknown }
}

// rrweb enum values we rely on (stable across rrweb 1.x/2.x):
const FULL_SNAPSHOT = 2 // EventType.FullSnapshot
const META = 4 // EventType.Meta
const INCREMENTAL = 3 // EventType.IncrementalSnapshot
const SOURCE_MOUSE_INTERACTION = 2 // IncrementalSource.MouseInteraction
const MOUSE_CLICK = 2 // MouseInteractions.Click

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

function warnExhausted(sessionId: string): void {
	console.warn(
		`[maple] session replay ${sessionId} reached its maximum recorded size; recording stopped for this session (metadata and events continue)`,
	)
}

// Dropped-batch warnings are rate-limited like transport failures.
let lastDropWarnAt = 0
function warnBufferDropped(bytes: number): void {
	const now = Date.now()
	if (now - lastDropWarnAt < 30_000) return
	lastDropWarnAt = now
	console.warn(
		`[maple] session replay buffer exceeded ${MAX_BUFFER_BYTES} bytes (dropping ${bytes} buffered bytes; recording continues from the next full snapshot)`,
	)
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
// An earlier page's chunk older than this is discarded instead of sent: consent
// withdrawn by a reload is never seen as a revoke, and must not be outlived by
// long. This page's own chunk has no such gap, since a revoke here removes it.
const MAX_PENDING_AGE_MS = 10 * 60_000
const PAGE_STARTED_AT = Date.now()

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

/** Send the chunk an earlier flush of this session left behind; any other stored chunk is dropped. */
function sendPendingChunk(config: IngestConfig, sessionId: string): void {
	const chunk = readPending()
	if (!chunk) return
	const sendable =
		chunk.sessionId === sessionId &&
		chunk.target === targetOf(config) &&
		chunk.createdAt > consentRevokedAt() &&
		(chunk.createdAt >= PAGE_STARTED_AT || Date.now() - chunk.createdAt <= MAX_PENDING_AGE_MS)
	// Left stored until the POST, like the flush that stored it: a revoke can still
	// discard it, and a page gone mid-compression leaves it for the start after.
	if (sendable) void compressAndPost(config, chunk, chunk.body, false, true)
	else clearPendingChunk()
}

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
): Promise<BlobPostOutcome | undefined> {
	const meta: ChunkMeta = { sessionId, chunkSeq: nextChunkSeq(), ...chunk }
	// Stored synchronously: on a page going away nothing after the first await runs.
	const stored =
		keepalive && storePending({ ...meta, body, createdAt: Date.now(), target: targetOf(config) })
	return compressAndPost(config, meta, body, keepalive, stored)
}

async function compressAndPost(
	config: IngestConfig,
	meta: ChunkMeta,
	body: string,
	keepalive: boolean,
	stored: boolean,
): Promise<BlobPostOutcome | undefined> {
	// `gzip` rejects rather than returning a truncated stream, and callers run
	// this as a floating promise: an escaping rejection would surface in the
	// host app's console as ours. Dropping the chunk is the same outcome ingest
	// produced by refusing it, minus the wasted POST.
	let gzipped: Uint8Array
	try {
		gzipped = await gzip(new TextEncoder().encode(body))
	} catch (error) {
		warnDropped("chunk compression", error)
		return undefined
	}
	if (stored) {
		// A request that does not get keepalive dies with the page, after the copy is
		// gone. So one that does not fit the shared budget right now stays stored for
		// the next recorder start. Released at once: the POST below reserves again
		// synchronously, before anything else can run.
		if (keepalive) {
			const release = reserveKeepalive(true, gzipped.byteLength)
			if (!release) return undefined
			release()
		}
		// Gone: a later recorder start already sent it, or a revoke discarded it.
		if (!takePending(meta)) return undefined
	}
	return postSessionBlob(config, meta, gzipped, keepalive)
}

export function startRecording(config: IngestConfig, sessionId: string): Recorder {
	sendPendingChunk(config, sessionId)
	// Events are serialized once at emit time and buffered as JSON strings, so
	// flushing is a cheap `join` instead of re-stringifying the whole buffer
	// (which stalls the main thread for hundreds of ms on full snapshots).
	let parts: string[] = []
	let bufferBytes = 0
	let bufferHasCheckpoint = false
	let firstTimestamp = 0
	let lastTimestamp = 0
	let droppedChunk = false
	let clickCount = 0
	let stopped = false
	// Set once ingest answers 413: the session hit its recorded-size ceiling and
	// every further chunk would get the same answer. Recording and uploads end
	// here for THIS session id (a rotation starts a fresh recorder with a fresh
	// budget); the lifecycle — heartbeats, the `ended` row, distilled events —
	// carries on. Before this existed one long session posted a rejected chunk
	// every 5s for the rest of the page's life: 149k 413s against 14k accepted
	// chunks for one org over two days.
	let exhausted = false

	const resetBuffer = () => {
		parts = []
		bufferBytes = 0
		bufferHasCheckpoint = false
		firstTimestamp = 0
		lastTimestamp = 0
	}

	const flush = async (keepalive = false): Promise<void> => {
		// A stopped recorder must not upload, ever. `stop()` is the consent-revoke
		// path — it discards rather than sends — and the only thing that can still
		// call in here afterwards is a flush scheduled before the revoke landed.
		if (stopped || exhausted || parts.length === 0) return
		const body = `[${parts.join(",")}]`
		const isCheckpoint = bufferHasCheckpoint
		const eventCount = parts.length
		const durationMs = Math.max(0, lastTimestamp - firstTimestamp)
		resetBuffer()
		const outcome = await uploadChunk(
			config,
			sessionId,
			body,
			{ isCheckpoint, eventCount, durationMs },
			keepalive,
		)
		if (outcome === "exhausted" && !exhausted) {
			exhausted = true
			warnExhausted(sessionId)
			haltCapture()
		}
	}

	// Assigned once rrweb is started below; `flush` may need it before then only
	// in theory (nothing is buffered before the first emit), so a no-op default.
	let haltCapture: () => void = () => {}

	const stop = record({
		emit: (event: unknown, isCheckpoint?: boolean) => {
			// Resolve idle rotation at event time, not when a timer later flushes.
			// The rotation listener stops this recorder and starts a new one; this
			// first event is intentionally left to the distilled sink rather than
			// being written under the expired replay id.
			const active = markActivity()
			if (active && active.id !== sessionId) return
			const e = event as RrwebEvent
			// The meta event carries the page URL the player shows in its address bar.
			if (e.type === META && e.data && typeof e.data.href === "string") {
				e.data.href = scrubUrl(e.data.href)
			}
			const isFullSnapshot = isCheckpoint === true || e.type === FULL_SNAPSHOT
			if (
				e.type === INCREMENTAL &&
				e.data?.source === SOURCE_MOUSE_INTERACTION &&
				e.data.type === MOUSE_CLICK
			) {
				clickCount++
			}

			let json: string
			try {
				json = JSON.stringify(e)
			} catch {
				// Unserializable event (cycles) — playback can't use it anyway.
				return
			}

			// After a dropped batch the stream has a gap; incremental events are
			// useless until the next full snapshot re-establishes a base.
			if (droppedChunk && !isFullSnapshot) return
			droppedChunk = false

			// Flushing at FLUSH_BYTES resets the buffer synchronously, so only a
			// single pathological event (a multi-MB snapshot of a huge DOM) can trip
			// this. Deliberately NO takeFullSnapshot recovery here: re-snapshotting
			// the same DOM would emit another over-cap event and loop the stall.
			// The next periodic checkout re-establishes the base instead.
			if (bufferBytes + json.length > MAX_BUFFER_BYTES) {
				warnBufferDropped(bufferBytes + json.length)
				resetBuffer()
				droppedChunk = true
				return
			}

			if (isFullSnapshot) bufferHasCheckpoint = true
			if (parts.length === 0) firstTimestamp = e.timestamp
			lastTimestamp = e.timestamp
			parts.push(json)
			bufferBytes += json.length
			if (bufferBytes >= FLUSH_BYTES) void flush()
		},
		maskAllInputs: config.maskAllInputs,
		// The README and docs advertise `data-rr-block` alongside `.rr-block`, but
		// rrweb defaults `blockSelector` to null — the attribute silently did
		// nothing, so anyone who marked up sensitive elements from the docs was
		// still being recorded. Declaring it makes the documented hook real.
		blockSelector: BLOCK_SELECTOR,
		// rrweb has no `maskAllText` flag; selecting all elements masks every text node.
		...(config.maskAllText ? { maskTextSelector: "*" } : undefined),
		checkoutEveryNms: CHECKOUT_EVERY_MS,
		...canvasOptions(config),
	})

	// The periodic flush yields to idle time so it never competes with an
	// in-progress interaction; the timeout bounds staleness. Explicit flushes
	// (pagehide/unload) bypass this and run immediately.
	//
	// The handle is retained so `stop()` can cancel it: a callback already
	// queued when consent is revoked would otherwise still fire — up to the 2s
	// timeout later — and upload the buffer the revoke was meant to discard.
	let idleHandle: number | undefined
	const scheduleFlush = () => {
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

	// Shared by consent revoke and budget exhaustion: end rrweb, cancel pending
	// flush work, drop the buffer. Only `stopped` (revoke) also forbids the
	// caller's later explicit `flush()`s — after exhaustion they are simply
	// no-ops because ingest would refuse them.
	let halted = false
	haltCapture = () => {
		if (halted) return
		halted = true
		clearInterval(flushTimer)
		if (idleHandle !== undefined && typeof cancelIdleCallback === "function") {
			cancelIdleCallback(idleHandle)
			idleHandle = undefined
		}
		// Nothing may be uploaded from here on, so the buffer is dead weight —
		// and on a revoke it is dead weight holding recorded user data.
		resetBuffer()
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
}

export interface BufferedRecorder {
	/** Upload what is buffered, oldest first, each segment a checkpoint chunk. */
	drain: (keepalive?: boolean) => Promise<void>
	stop: () => void
	getClickCount: () => number
}

/**
 * Record into memory only: the segments since the second-to-last checkout, so
 * 30-60s of replay, and nothing is uploaded until `drain()`. For sessions that
 * keep a replay only when an error happens.
 */
export function startBufferedRecording(config: IngestConfig, sessionId: string): BufferedRecorder {
	let segments: Segment[] = []
	let bytes = 0
	let clickCount = 0
	let stopped = false
	/** Incremental events since the last snapshot: an idle page needs no new one. */
	let changedSinceSnapshot = 0

	const stopRecord = record({
		emit: (event: unknown) => {
			const active = markActivity()
			if (stopped || (active && active.id !== sessionId)) return
			const e = event as RrwebEvent
			if (e.type === META && e.data && typeof e.data.href === "string")
				e.data.href = scrubUrl(e.data.href)
			if (
				e.type === INCREMENTAL &&
				e.data?.source === SOURCE_MOUSE_INTERACTION &&
				e.data.type === MOUSE_CLICK
			) {
				clickCount++
			}
			let json: string
			try {
				json = JSON.stringify(e)
			} catch {
				return
			}
			// Every snapshot, first or checkout, is a Meta event then a FullSnapshot.
			if (e.type === META) {
				segments.push({ parts: [], bytes: 0, first: e.timestamp, last: e.timestamp })
				while (segments.length > 2) bytes -= segments.shift()?.bytes ?? 0
				changedSinceSnapshot = 0
			} else if (e.type === INCREMENTAL) {
				changedSinceSnapshot++
			}
			const segment = segments.at(-1)
			// Nothing to play back before the first snapshot.
			if (!segment) return
			segment.parts.push(json)
			segment.bytes += json.length
			segment.last = e.timestamp
			bytes += json.length
			while (bytes > MAX_BUFFER_BYTES && segments.length > 0) bytes -= segments.shift()?.bytes ?? 0
		},
		maskAllInputs: config.maskAllInputs,
		blockSelector: BLOCK_SELECTOR,
		...(config.maskAllText ? { maskTextSelector: "*" } : undefined),
		...canvasOptions(config),
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
			const pending = segments
			segments = []
			bytes = 0
			if (stopped) return
			// Each call claims its chunk seq synchronously, so these stay ahead of
			// whatever the streaming recorder that follows uploads.
			await Promise.all(
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
		},
		stop: () => {
			stopped = true
			clearInterval(checkoutTimer)
			segments = []
			bytes = 0
			stopRecord?.()
		},
		getClickCount: () => clickCount,
	}
}
