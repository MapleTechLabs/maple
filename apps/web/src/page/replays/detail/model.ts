import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { ReplaySearch } from "../../../route/search"
import * as CopyButton from "../../../ui/copy-button"
import { RangeMeta, ReplayMeta } from "../kit/replay-meta"

// The replay detail page.

/** `replayDetailFromV2`: the session row the studio renders. */
export const ReplayDetail = Schema.Struct({
	sessionId: Schema.String,
	startTime: Schema.String,
	durationMs: Schema.NullOr(Schema.Number),
	status: Schema.String,
	lastActivityAt: Schema.NullOr(Schema.String),
	userId: Schema.NullOr(Schema.String),
	userName: Schema.String,
	userEmail: Schema.String,
	groupId: Schema.String,
	groupName: Schema.String,
	visitorId: Schema.String,
	utmSource: Schema.String,
	entryPath: Schema.String,
	urlInitial: Schema.String,
	browserName: Schema.String,
	osName: Schema.String,
	deviceType: Schema.String,
	country: Schema.String,
	serviceName: Schema.String,
	pageViews: Schema.Number,
	clickCount: Schema.Number,
	errorCount: Schema.Number,
	visitorIsNew: Schema.Boolean,
	userTraits: Schema.String,
	referrerHost: Schema.String,
	utmMedium: Schema.String,
	utmCampaign: Schema.String,
	exitPath: Schema.String,
	userAgent: Schema.String,
	traceIds: Schema.Array(Schema.String),
	resourceAttributes: Schema.String,
	activeTimeMs: Schema.NullOr(Schema.Number),
	idleTimeMs: Schema.NullOr(Schema.Number),
})
export type ReplayDetail = typeof ReplayDetail.Type

export const ChunkMeta = Schema.Struct({
	chunk_seq: Schema.Number,
	timestamp: Schema.String,
	duration_ms: Schema.Number,
	event_count: Schema.Number,
	byte_size: Schema.Number,
	is_checkpoint: Schema.Boolean,
})

export const Manifest = Schema.Struct({
	chunks: Schema.Array(ChunkMeta),
	maxBytesPerRequest: Schema.Number,
	maxChunksPerRequest: Schema.Number,
})
export type Manifest = typeof Manifest.Type

/** One `session_events` row of the rail (`EventRow`). */
export const EventRow = Schema.Struct({
	timestamp: Schema.String,
	type: Schema.String,
	url: Schema.String,
	traceId: Schema.NullOr(Schema.String),
	level: Schema.String,
	message: Schema.String,
	targetSelector: Schema.String,
	targetText: Schema.String,
	netMethod: Schema.String,
	netUrl: Schema.String,
	netStatus: Schema.Number,
	netDurationMs: Schema.Number,
	errorStack: Schema.String,
	attributes: Schema.optional(Schema.String),
})
export type EventRow = typeof EventRow.Type

export const TraceSummary = Schema.Struct({
	traceId: Schema.String,
	startTime: Schema.String,
	durationMs: Schema.Number,
	rootSpanName: Schema.String,
	rootServiceName: Schema.String,
	rootSpanKind: Schema.optional(Schema.String),
	rootSpanAttributes: Schema.optional(Schema.String),
	spanCount: Schema.Number,
	hasError: Schema.Number,
})
export type TraceSummary = typeof TraceSummary.Type

export const SpanRow = Schema.Struct({
	spanId: Schema.String,
	spanName: Schema.String,
	serviceName: Schema.String,
	startTime: Schema.String,
	durationMs: Schema.Number,
	statusCode: Schema.String,
	spanAttributes: Schema.Record(Schema.String, Schema.String),
	spanKind: Schema.String,
})
export type SpanRow = typeof SpanRow.Type

export const SpansData = AsyncData.Schema(Schema.Array(SpanRow), LoadFailure)

export const Range = Schema.Struct({ fromChunkSeq: Schema.Number, toChunkSeq: Schema.Number })
export type Range = typeof Range.Type

/** One range's chunk rows, each chunk's JSON already parsed (a malformed chunk is empty). */
export const RangeRows = Schema.Array(
	Schema.Struct({ chunk_seq: Schema.Number, events: Schema.Array(Schema.Unknown) }),
)
export type RangeRows = typeof RangeRows.Type

export const LoadedRange = Schema.Struct({
	key: Schema.String,
	range: Range,
	events: Schema.Array(Schema.Unknown),
	lastChunkSeq: Schema.Number,
})
export type LoadedRange = typeof LoadedRange.Type

/** `useReplayChunkLoader`'s state. */
export const Loader = Schema.Struct({
	isPlanned: Schema.Boolean,
	loaded: Schema.Array(LoadedRange),
	seedCount: Schema.Number,
	/** The seed's events, cut once per `seedVersion` so ticks and views do not re-flatten them. */
	seed: Schema.Array(Schema.Unknown),
	queue: Schema.Array(Range),
	seekTargetMs: Schema.NullOr(Schema.Number),
	isSeeking: Schema.Boolean,
	playheadMs: Schema.Number,
	/** The range the events subscription reads (`subscribedRange`). */
	range: KeyedSchema(RangeRows, LoadFailure),
	/** Answers already received, by range request key (the atom cache), oldest first, capped. */
	rangeCache: Schema.Record(Schema.String, RangeRows),
	/** Seeds so far: the engine element is keyed by it, so a new seed mounts a new engine. */
	seedVersion: Schema.Number,
	/** Epoch ms of the recording's first loaded event: time zero for every seed, including later ones. */
	originMs: Schema.NullOr(Schema.Number),
	/** Markers and idle gaps of every range loaded so far, kept across seeks. */
	rangeMetas: Schema.Array(RangeMeta),
	/** Planned ranges fetched so far (by first chunk), for their markers and gaps even when not playable. */
	fetchedRanges: Schema.Array(Schema.Number),
	/** Play as soon as the next seed's engine is ready: a seek or slide that interrupted playback. */
	resumeOnReady: Schema.Boolean,
})
export type Loader = typeof Loader.Type

export const RailTab = Schema.Literals(["events", "traces", "session"])
export type RailTab = typeof RailTab.Type

export const EventFilter = Schema.Literals(["all", "custom", "console", "network", "error"])
export type EventFilter = typeof EventFilter.Type

export const Player = Schema.Struct({
	isPlaying: Schema.Boolean,
	isFinished: Schema.Boolean,
	/** Real ms from recording start. */
	currentMs: Schema.Number,
	totalMs: Schema.Number,
	speed: Schema.Number,
	isSkippingIdle: Schema.Boolean,
	isFullscreen: Schema.Boolean,
	/** The last transport instruction for the engine Mount. */
	control: Schema.String,
	controlNonce: Schema.Number,
})
export type Player = typeof Player.Type

export const Model = Schema.Struct({
	sessionId: Schema.String,
	search: ReplaySearch,
	nowMs: Schema.Number,
	detail: KeyedSchema(Schema.NullOr(ReplayDetail), LoadFailure),
	manifest: KeyedSchema(Manifest, LoadFailure),
	transcript: KeyedSchema(Schema.Array(EventRow), LoadFailure),
	traceSummaries: KeyedSchema(Schema.Array(TraceSummary), LoadFailure),
	loader: Loader,
	meta: ReplayMeta,
	player: Player,
	railTab: RailTab,
	eventFilter: EventFilter,
	openEventIndex: Schema.NullOr(Schema.Number),
	expandedTraces: Schema.Array(Schema.String),
	spans: Schema.Record(Schema.String, SpansData.schema),
	/** Copy buttons' status, by what they copy. */
	copies: Schema.Record(Schema.String, CopyButton.Model),
})
export type Model = typeof Model.Type
