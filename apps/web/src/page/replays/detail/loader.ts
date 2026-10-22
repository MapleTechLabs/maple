import { normalizeEvents } from "../../../components/replays/replay-events"
import { deriveRangeMeta, firstEventMs } from "../kit/replay-meta"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import {
	chunkAtOffset,
	chunkStartMs,
	checkpointAtOrBefore,
	INITIAL_WINDOW_BYTES,
	initialRanges,
	manifestStartMs,
	MAX_BYTES_PER_RANGE,
	MAX_CHUNKS_PER_RANGE,
	planRanges,
	rangeKey,
	rangesCovering,
	type ReplayRange,
} from "../kit/replay-range"
import type { LoadFailure } from "../../../data/load-failure"
import type { Loader, LoadedRange, Manifest, Model, RangeRows } from "./model"

// `useReplayChunkLoader` as pure functions of the Model: plan once per session, load ranges one at a
// time, commit each into `loaded`, and cut the seed when the opening queue drains.

export const emptyLoader = (): Loader => ({
	isPlanned: false,
	loaded: [],
	seedCount: 0,
	seed: [],
	queue: [],
	seekTargetMs: null,
	isSeeking: false,
	playheadMs: 0,
	range: { key: null, data: AsyncData.Idle() },
	rangeCache: {},
	seedVersion: 0,
	originMs: null,
	rangeMetas: [],
	fetchedRanges: [],
	failedRanges: [],
	backgroundFailure: null,
	resumeOnReady: false,
})

export const manifestOf = (model: Model): Manifest | undefined =>
	Option.getOrUndefined(AsyncData.getData(model.manifest.data))

export const chunksOf = (model: Model) => manifestOf(model)?.chunks ?? []

export const planOf = (model: Model): ReadonlyArray<ReplayRange> => {
	const manifest = manifestOf(model)
	if (manifest === undefined) return []
	return planRanges(
		manifest.chunks,
		Math.min(manifest.maxBytesPerRequest, MAX_BYTES_PER_RANGE),
		Math.min(manifest.maxChunksPerRequest, MAX_CHUNKS_PER_RANGE),
	)
}

/** `subscribedRange`: the active range, else the last loaded, else the plan's first, else 0–0. */
export const subscribedRange = (model: Model): ReplayRange =>
	model.loader.queue[0] ?? model.loader.loaded.at(-1)?.range ?? planOf(model)[0] ?? { fromChunkSeq: 0, toChunkSeq: 0 }

export const loadedThroughSeq = (loader: Loader): number =>
	loader.loaded.reduce((max, entry) => Math.max(max, entry.lastChunkSeq), -1)

export const seedEvents = (loader: Loader): ReadonlyArray<unknown> => loader.seed

/** How far into the recording the seed starts: 0 for the opening seed, more after a seek rebuild. */
export const seedShiftMs = (loader: Loader): number =>
	loader.originMs === null || loader.seed.length === 0 ? 0 : Math.max(0, firstEventMs(loader.seed) - loader.originMs)

/**
 * Event bytes the player holds at once. The rest of the recording downloads in the background for its
 * markers and idle gaps only. Covers ~99.7% of sessions whole; longer ones play in windows of this
 * size, rebuilt from a checkpoint as the playhead reaches each window's end.
 */
export const MAX_PLAYABLE_BYTES = 50_000_000

const bytesIn = (model: Model, range: ReplayRange): number =>
	chunksOf(model).reduce(
		(sum, chunk) =>
			chunk.chunk_seq >= range.fromChunkSeq && chunk.chunk_seq <= range.toChunkSeq ? sum + chunk.byte_size : sum,
		0,
	)

const loadedBytes = (model: Model): number =>
	model.loader.loaded.reduce((sum, entry) => sum + bytesIn(model, entry.range), 0)

/**
 * The planned range after the loaded span: by plan order, not `through + 1`, since the manifest can
 * skip a chunk right at a range boundary.
 */
const nextPlanned = (model: Model): ReplayRange | undefined => {
	const through = loadedThroughSeq(model.loader)
	return planOf(model).find((range) => range.fromChunkSeq > through)
}

/** The checkpoint a full window slides to: the latest one before the first chunk it lacks, if past its start. */
const slideAnchor = (model: Model) => {
	const anchor = checkpointAtOrBefore(chunksOf(model), loadedThroughSeq(model.loader) + 1)
	const windowStart = model.loader.loaded[0]?.range.fromChunkSeq ?? 0
	return anchor !== undefined && anchor.chunk_seq > windowStart ? anchor : undefined
}

/**
 * Whether `range` can join the playable window. Past the cap it can only when the window has nowhere
 * to slide (no checkpoint after its start): holding more beats a replay that freezes mid-session.
 */
const fitsWindow = (model: Model, range: ReplayRange): boolean =>
	loadedBytes(model) + bytesIn(model, range) <= MAX_PLAYABLE_BYTES || slideAnchor(model) === undefined

/** Range answers kept for re-seeks; the oldest go first past this many. */
export const RANGE_CACHE_LIMIT = 12

export const cacheRange = (
	cache: Loader["rangeCache"],
	key: string,
	rows: RangeRows,
): Loader["rangeCache"] => {
	const kept = Object.entries(cache).filter(([cached]) => cached !== key)
	const entries: ReadonlyArray<readonly [string, RangeRows]> = [...kept, [key, rows]]
	return Object.fromEntries(entries.slice(-RANGE_CACHE_LIMIT))
}

/** Ranges after the seed, for the feed Mounts. */
export const trailingRanges = (loader: Loader): ReadonlyArray<LoadedRange> =>
	loader.seedCount === 0 ? [] : loader.loaded.slice(loader.seedCount)

export const loadedUntilMs = (model: Model): number => {
	const through = loadedThroughSeq(model.loader)
	const chunks = chunksOf(model)
	const last = chunks.findLast((chunk) => chunk.chunk_seq <= through)
	return through < 0 || last === undefined ? 0 : chunkStartMs(last) + last.duration_ms - manifestStartMs(chunks)
}

export const hasMoreChunks = (model: Model): boolean => {
	const lastSeq = chunksOf(model).at(-1)?.chunk_seq
	const through = loadedThroughSeq(model.loader)
	return lastSeq !== undefined && through >= 0 && through < lastSeq
}

/** Plans the opening window once the manifest lands, and only once per session. */
export const planOnce = (model: Model): Model => {
	const chunks = chunksOf(model)
	if (model.loader.isPlanned || chunks.length === 0) return model
	return {
		...model,
		loader: {
			...model.loader,
			isPlanned: true,
			loaded: [],
			seedCount: 0,
			seed: [],
			isSeeking: false,
			seekTargetMs: null,
			queue: initialRanges(chunks, planOf(model)),
			originMs: null,
			rangeMetas: [],
			fetchedRanges: [],
			failedRanges: [],
			backgroundFailure: null,
			resumeOnReady: false,
		},
	}
}

/** Commits the active range from its answer and advances the queue; cuts the seed when it drains. */
export const advance = (model: Model, rows: Option.Option<RangeRows>): Model => {
	const { loader } = model
	const active = loader.queue[0]
	if (active === undefined) return cutSeed(model)
	const key = rangeKey(active)
	if (loader.loaded.some((entry) => entry.key === key))
		return advance({ ...model, loader: { ...loader, queue: loader.queue.slice(1) } }, rows)
	if (Option.isNone(rows)) return model
	const through = loadedThroughSeq(loader)
	const own = rows.value
		.filter((row) => row.chunk_seq >= active.fromChunkSeq && row.chunk_seq <= active.toChunkSeq)
		.toSorted((a, b) => a.chunk_seq - b.chunk_seq)
	const events = normalizeEvents(own.flatMap((row) => row.events))
	const originMs = loader.originMs ?? (events.length > 0 ? firstEventMs(events) : null)
	const isKnown = loader.rangeMetas.some((meta) => meta.fromChunkSeq === active.fromChunkSeq)
	const rangeMetas =
		originMs === null || isKnown || events.length === 0
			? loader.rangeMetas
			: [...loader.rangeMetas, deriveRangeMeta(active, events, originMs)]
	const fetchedRanges = loader.fetchedRanges.includes(active.fromChunkSeq)
		? loader.fetchedRanges
		: [...loader.fetchedRanges, active.fromChunkSeq]
	// The opening window always plays; after it, a range joins the player only while it continues the
	// loaded span and fits the cap. Anything else was fetched for its markers alone.
	const isPlayable =
		loader.seedCount === 0 ||
		(active.fromChunkSeq === nextPlanned(model)?.fromChunkSeq && fitsWindow(model, active))
	const loaded: ReadonlyArray<LoadedRange> = isPlayable
		? [
				...loader.loaded,
				// Through the range's planned end, so a chunk missing from it never stalls the next range.
				{ key, range: active, events, lastChunkSeq: Math.max(active.toChunkSeq, through) },
			]
		: loader.loaded
	return continueDownload(
		cutSeed({
			...model,
			loader: { ...loader, loaded, queue: loader.queue.slice(1), originMs, rangeMetas, fetchedRanges },
		}),
	)
}

/**
 * Keep downloading until the whole recording is fetched: the next playable range while it fits the
 * cap, then the rest for its markers and gaps.
 */
const continueDownload = (model: Model): Model => {
	const { loader } = model
	if (loader.seedCount === 0 || loader.queue.length > 0) return model
	const playable = nextPlanned(model)
	const isSkipped = (range: ReplayRange) =>
		loader.fetchedRanges.includes(range.fromChunkSeq) || loader.failedRanges.includes(range.fromChunkSeq)
	const next =
		playable !== undefined && !loader.failedRanges.includes(playable.fromChunkSeq) && fitsWindow(model, playable)
			? playable
			: // The first range never fetched, wherever it is: a seek can jump the download past some.
				planOf(model).find((range) => !isSkipped(range))
	return next === undefined ? model : { ...model, loader: { ...loader, queue: [next] } }
}

const cutSeed = (model: Model): Model => {
	const { loader } = model
	if (loader.queue.length > 0 || loader.loaded.length === 0 || loader.seedCount > 0) return model
	return {
		...model,
		loader: {
			...loader,
			seedCount: loader.loaded.length,
			seed: loader.loaded.flatMap((entry) => entry.events),
			isSeeking: false,
			seedVersion: loader.seedVersion + 1,
		},
	}
}

/** Where the loaded span starts, in ms from the recording's start. */
export const loadedFromMs = (model: Model): number => {
	const from = model.loader.loaded[0]?.range.fromChunkSeq
	const chunks = chunksOf(model)
	const first = chunks.find((chunk) => chunk.chunk_seq === from)
	return first === undefined ? 0 : chunkStartMs(first) - manifestStartMs(chunks)
}

const rebuildAt = (model: Model, offsetMs: number, anchorSeq: number, resume: boolean): Model => ({
	...model,
	loader: {
		...model.loader,
		playheadMs: offsetMs,
		loaded: [],
		seedCount: 0,
		seed: [],
		isSeeking: true,
		seekTargetMs: offsetMs,
		resumeOnReady: resume,
		queue: rangesCovering(chunksOf(model), planOf(model), anchorSeq, INITIAL_WINDOW_BYTES),
	},
})

/**
 * `reportProgress`: track the playhead. Past the cap, the playhead reaching the end of the playable
 * window rebuilds the player from the latest checkpoint before it, and playback carries on.
 */
export const reportProgress = (model: Model, offsetMs: number, isStarved = false): Model => {
	const next = { ...model, loader: { ...model.loader, playheadMs: offsetMs } }
	const { loader } = next
	// The engine running dry is the window's end whatever the manifest's estimate of it says.
	const isAtEnd = isStarved || offsetMs + 1_000 >= loadedUntilMs(next)
	if (loader.seedCount === 0 || !hasMoreChunks(next) || !isAtEnd) return next
	const playable = nextPlanned(next)
	if (playable === undefined || fitsWindow(next, playable)) return next
	const anchor = slideAnchor(next)
	if (anchor === undefined) return next
	return rebuildAt(next, offsetMs, anchor.chunk_seq, true)
}

/** `requestSeek`: a rebuilt loader when the target is outside the loaded span. */
export const requestSeek = (model: Model, offsetMs: number, resume: boolean): Option.Option<Model> => {
	const chunks = chunksOf(model)
	const loader = { ...model.loader, playheadMs: offsetMs }
	const target = chunkAtOffset(chunks, offsetMs)
	if (target === undefined) return Option.none()
	const isLoaded =
		target.chunk_seq <= loadedThroughSeq(loader) &&
		loader.loaded.some(
			(entry) => target.chunk_seq >= entry.range.fromChunkSeq && target.chunk_seq <= entry.range.toChunkSeq,
		)
	if (isLoaded) return Option.none()
	const anchor = checkpointAtOrBefore(chunks, target.chunk_seq)
	if (anchor === undefined) return Option.none()
	return Option.some(rebuildAt({ ...model, loader }, offsetMs, anchor.chunk_seq, resume))
}

/** A background range failed: skip it and carry on with the rest of the download. */
export const skipFailed = (model: Model, failure: LoadFailure): Model => {
	const active = model.loader.queue[0]
	if (active === undefined) return model
	const { loader } = model
	return continueDownload({
		...model,
		loader: {
			...loader,
			queue: loader.queue.slice(1),
			failedRanges: [...loader.failedRanges, active.fromChunkSeq],
			backgroundFailure: failure,
		},
	})
}

/** The background failure the playhead has reached: the next playable range failed and the window is used up. */
export const neededFailure = (model: Model): LoadFailure | null => {
	const { loader } = model
	const next = nextPlanned(model)
	return loader.backgroundFailure !== null &&
		loader.seedCount > 0 &&
		next !== undefined &&
		loader.failedRanges.includes(next.fromChunkSeq) &&
		loader.playheadMs + 1_000 >= loadedUntilMs(model)
		? loader.backgroundFailure
		: null
}

/** Retry after a background failure: forget the failures and rebuild from a checkpoint at the playhead. */
export const retryAt = (model: Model, offsetMs: number): Model => {
	const chunks = chunksOf(model)
	const target = chunkAtOffset(chunks, offsetMs)
	const anchor = target === undefined ? undefined : checkpointAtOrBefore(chunks, target.chunk_seq)
	const cleared: Model = { ...model, loader: { ...model.loader, failedRanges: [], backgroundFailure: null } }
	return anchor === undefined ? cleared : rebuildAt(cleared, offsetMs, anchor.chunk_seq, false)
}

/** `bufferState === "buffering"`: the playhead reached the loaded end while more is coming. */
export const isBuffering = (model: Model): boolean =>
	!model.loader.isSeeking &&
	model.loader.queue.length > 0 &&
	model.loader.seedCount > 0 &&
	model.loader.playheadMs + 1_000 >= loadedUntilMs(model) &&
	hasMoreChunks(model)
