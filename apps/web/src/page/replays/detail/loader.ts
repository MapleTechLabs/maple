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
	rangeContaining,
	rangeKey,
	rangesCovering,
	type ReplayRange,
} from "../kit/replay-range"
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

const loadedUntilMs = (model: Model): number => {
	const through = loadedThroughSeq(model.loader)
	const chunks = chunksOf(model)
	const last = chunks.find((chunk) => chunk.chunk_seq === through)
	return through < 0 || last === undefined ? 0 : chunkStartMs(last) + last.duration_ms - manifestStartMs(chunks)
}

const hasMoreChunks = (model: Model): boolean => {
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
		.filter(
			(row) => row.chunk_seq >= active.fromChunkSeq && row.chunk_seq <= active.toChunkSeq && row.chunk_seq > through,
		)
		.toSorted((a, b) => a.chunk_seq - b.chunk_seq)
	const events = normalizeEvents(own.flatMap((row) => row.events))
	const entry: LoadedRange = {
		key,
		range: active,
		events,
		lastChunkSeq: own.reduce((max, row) => Math.max(max, row.chunk_seq), through),
	}
	const originMs = loader.originMs ?? (events.length > 0 ? firstEventMs(events) : null)
	const isKnown = loader.rangeMetas.some((meta) => meta.fromChunkSeq === active.fromChunkSeq)
	const rangeMetas =
		originMs === null || isKnown || events.length === 0
			? loader.rangeMetas
			: [...loader.rangeMetas, deriveRangeMeta(active, events, originMs)]
	return cutSeed({
		...model,
		loader: { ...loader, loaded: [...loader.loaded, entry], queue: loader.queue.slice(1), originMs, rangeMetas },
	})
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

/** `reportProgress`: keep the next range coming while the playhead nears the loaded end. */
export const reportProgress = (model: Model, offsetMs: number): Model => {
	const loader = { ...model.loader, playheadMs: offsetMs }
	const next = { ...model, loader }
	if (loader.seedCount === 0 || offsetMs + 20_000 < loadedUntilMs(next) || !hasMoreChunks(next)) return next
	if (loader.queue.length > 0) return next
	const range = rangeContaining(planOf(next), loadedThroughSeq(loader) + 1)
	if (range === undefined || loader.loaded.some((entry) => entry.key === rangeKey(range))) return next
	return { ...next, loader: { ...loader, queue: [range] } }
}

/** `requestSeek`: true (and a reset loader) when the target is outside the loaded span. */
export const requestSeek = (model: Model, offsetMs: number): Option.Option<Model> => {
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
	return Option.some({
		...model,
		loader: {
			...loader,
			loaded: [],
			seedCount: 0,
			seed: [],
			isSeeking: true,
			seekTargetMs: offsetMs,
			queue: rangesCovering(chunks, planOf(model), anchor.chunk_seq, INITIAL_WINDOW_BYTES),
		},
	})
}

/** `bufferState === "buffering"`: the playhead reached the loaded end while more is coming. */
export const isBuffering = (model: Model): boolean =>
	!model.loader.isSeeking &&
	model.loader.queue.length > 0 &&
	model.loader.seedCount > 0 &&
	model.loader.playheadMs + 1_000 >= loadedUntilMs(model) &&
	hasMoreChunks(model)
