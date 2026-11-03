import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { Copies } from "../kit/copies"

// One session's detail, as Schemas: the columns the page reads.

export const SessionDetail = Schema.Struct({
	sessionId: Schema.String,
	startTime: Schema.DateTimeUtc,
	durationMs: Schema.NullOr(Schema.Number),
	status: Schema.String,
	lastActivityAt: Schema.NullOr(Schema.DateTimeUtc),
	userId: Schema.String,
	userName: Schema.String,
	userEmail: Schema.String,
	urlInitial: Schema.String,
	userAgent: Schema.String,
	browserName: Schema.String,
	osName: Schema.String,
	deviceType: Schema.String,
	serviceName: Schema.String,
	pageViews: Schema.Number,
	clickCount: Schema.Number,
	errorCount: Schema.Number,
	traceIds: Schema.Array(Schema.String),
})
export type SessionDetail = typeof SessionDetail.Type

export const TranscriptEvent = Schema.Struct({
	timestamp: Schema.DateTimeUtc,
	seq: Schema.Number,
	type: Schema.String,
	url: Schema.String,
	level: Schema.String,
	message: Schema.String,
	targetSelector: Schema.String,
	targetText: Schema.String,
	netMethod: Schema.String,
	netUrl: Schema.String,
	netStatus: Schema.Number,
	netDurationMs: Schema.Number,
	errorStack: Schema.String,
})
export type TranscriptEvent = typeof TranscriptEvent.Type

export const SessionTrace = Schema.Struct({
	traceId: Schema.String,
	durationMs: Schema.Number,
	rootSpanName: Schema.String,
	rootServiceName: Schema.String,
	spanCount: Schema.Number,
	hasError: Schema.Number,
})
export type SessionTrace = typeof SessionTrace.Type

export const Model = Schema.TaggedStruct("SessionDetailPage", {
	sessionId: Schema.String,
	/** The clock at the last read, for live-ness and "started 3m ago". */
	nowMs: Schema.Number,
	/** `null` once loaded: the session was not found. */
	detail: KeyedSchema(Schema.NullOr(SessionDetail), LoadFailure),
	transcript: KeyedSchema(Schema.Array(TranscriptEvent), LoadFailure),
	traces: KeyedSchema(Schema.Array(SessionTrace), LoadFailure),
	/** `dataUpdatedAt` of the detail, for the "New data" pill. */
	detailUpdatedAtMs: Schema.Number,
	isRefreshing: Schema.Boolean,
	copies: Copies,
})
export type Model = typeof Model.Type
