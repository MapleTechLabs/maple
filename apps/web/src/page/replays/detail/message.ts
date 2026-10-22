import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as CopyButton from "../../../ui/copy-button"
import {
	EventFilter,
	EventRow,
	Manifest,
	RailTab,
	RangeRows,
	ReplayDetail,
	SpanRow,
	TraceSummary,
} from "./model"

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveClock: { nowMs: Schema.Number },
	CompletedFetchDetail: result(Schema.NullOr(ReplayDetail)),
	CompletedFetchManifest: result(Manifest),
	CompletedFetchTranscript: result(Schema.Array(EventRow)),
	CompletedFetchTraceSummaries: result(Schema.Array(TraceSummary)),
	CompletedFetchRange: result(RangeRows),
	CompletedFetchSpans: {
		traceId: Schema.String,
		result: Schema.Result(Schema.Array(SpanRow), LoadFailure),
	},
	/** The engine Mount built its engine (`engine.totalTimeMs`). */
	ReadiedEngine: { seedVersion: Schema.Number, totalMs: Schema.Number },
	/** The engine clock while playing, or after a jump over an idle gap. */
	TickedEngine: { seedVersion: Schema.Number, currentMs: Schema.Number },
	FinishedEngine: { seedVersion: Schema.Number },
	ClickedPlay: {},
	/** A press on a scrub surface; a Command measures where along it the pointer landed. */
	PressedScrubber: { surface: Schema.Literals(["transport", "timeline"]), clientX: Schema.Number },
	/** The measured press, as a share of the surface's width. */
	MeasuredScrub: { ratio: Schema.Number },
	/** A timeline bar or a rail row asked for a display position. */
	RequestedSeek: { displayMs: Schema.Number },
	/** Arrow keys: relative to the playhead, in display ms. */
	RequestedSeekBy: { deltaMs: Schema.Number },
	/** A rail row's warehouse timestamp. */
	RequestedSeekToTimestamp: { timestamp: Schema.String },
	PickedSpeed: { speed: Schema.Number },
	ToggledSkipIdle: {},
	ClickedFullscreen: {},
	ChangedFullscreen: { isFullscreen: Schema.Boolean },
	CompletedFullscreenToggle: {},
	/** A feed Mount handed its range to the live engine. */
	FedTrailingEvents: {},
	ClickedRetryPlayer: {},
	PickedRailTab: { tab: RailTab },
	PickedEventFilter: { filter: EventFilter },
	ClickedEvent: { index: Schema.Number, timestamp: Schema.String },
	ToggledTraceSpans: { traceId: Schema.String, startTime: Schema.String },
	GotCopyMessage: { key: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type
