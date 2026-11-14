import { Schema } from "effect"
import { AsyncData } from "foldkit"

// What the golden-signal grid and its commit markers read, for a service or a release.

/** `ServiceDetailTimeSeriesPoint` (@maple/web-data/warehouse/services). */
export const DetailPoint = Schema.Struct({
	bucket: Schema.String,
	throughput: Schema.Number,
	tracedThroughput: Schema.Number,
	hasSampling: Schema.Boolean,
	samplingWeight: Schema.Number,
	errorRate: Schema.Number,
	p50LatencyMs: Schema.Number,
	p95LatencyMs: Schema.Number,
	p99LatencyMs: Schema.Number,
	apdexScore: Schema.Number,
	totalCount: Schema.Number,
	partial: Schema.Boolean,
})
export type DetailPoint = typeof DetailPoint.Type

/** `ReleasePoint` (./marker-layout.ts). */
export const Release = Schema.Struct({
	bucket: Schema.String,
	commitSha: Schema.String,
	count: Schema.Number,
	errorCount: Schema.Number,
})
export type Release = typeof Release.Type

/** The `VcsCommitDetailResponse` fields the deploy rows and marker labels read. */
export const Commit = Schema.Struct({
	sha: Schema.String,
	message: Schema.String,
	authorName: Schema.NullOr(Schema.String),
	authorLogin: Schema.NullOr(Schema.String),
	authorAvatarUrl: Schema.NullOr(Schema.String),
	committedAt: Schema.Number,
})
export type Commit = typeof Commit.Type

/** A failed commit lookup keeps its error tag: "not connected" gets one panel-level CTA. */
export const CommitFailure = Schema.Struct({ tag: Schema.String })
export type CommitFailure = typeof CommitFailure.Type
export const CommitData = AsyncData.Schema(Commit, CommitFailure)
export type CommitData = AsyncData.AsyncData<Commit, CommitFailure>
