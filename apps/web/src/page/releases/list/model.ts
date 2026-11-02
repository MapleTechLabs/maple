import { CommitSha, ServiceName, VcsCommitDetailResponse, VcsCommitRangeResponse } from "@maple/domain/http"
import { V2ErrorIssue } from "@maple/domain/http/v2"
import { Schema } from "effect"
import * as Overlays from "../overlays"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { ReleasesSearch } from "../../../route/search"
import * as FilterSections from "../../../ui/filters/filter-sections"
import { SignalPresenceData } from "../../kit/signal-presence"
import * as TimeRangePicker from "../../kit/time-range-picker"

// `/releases`.

/** `Release` (`@maple/web-data/warehouse/releases`): a release row, `firstSeen` in ISO. */
export const ReleaseRow = Schema.Struct({
	serviceName: ServiceName,
	environment: Schema.String,
	commitSha: CommitSha,
	firstSeen: Schema.String,
	spanCount: Schema.Number,
	errorCount: Schema.Number,
	p50LatencyMs: Schema.Number,
	p95LatencyMs: Schema.Number,
	p99LatencyMs: Schema.Number,
	apdexScore: Schema.Number,
})

/** `ReleaseTimelineBucket`. */
export const TimelineBucket = Schema.Struct({
	bucket: Schema.String,
	serviceName: ServiceName,
	commitSha: CommitSha,
	count: Schema.Number,
})

/** `ReleasesResult`. */
export const ReleasesData = Schema.Struct({
	releases: Schema.Array(ReleaseRow),
	timeline: Schema.Array(TimelineBucket),
	truncated: Schema.Boolean,
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
})
export type ReleasesData = typeof ReleasesData.Type

/** One page of `errorIssues.list` (`introduced_after`) and whether more were introduced. */
export const IssuePage = Schema.Struct({ data: Schema.Array(V2ErrorIssue), hasMore: Schema.Boolean })
export type IssuePage = typeof IssuePage.Type

export const Model = Schema.Struct({
	search: ReleasesSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
	releases: KeyedSchema(ReleasesData, LoadFailure),
	/** What `ReleasesTable` reads once it mounts: issue counts, commit messages, commit ranges. */
	hasPaintedTable: Schema.Boolean,
	issues: KeyedSchema(IssuePage, LoadFailure),
	commits: KeyedSchema(Schema.Array(VcsCommitDetailResponse), LoadFailure),
	ranges: KeyedSchema(Schema.Array(VcsCommitRangeResponse), LoadFailure),
	/** `useTrackWidth`: the timeline's first track, for the marker merge distance. */
	trackWidth: Schema.Number,
	/** `ReleasesTableRows`' expanded commits. */
	expanded: Schema.Array(Schema.String),
	filterSections: FilterSections.Model,
	timePicker: TimeRangePicker.Model,
	/** The health pills' tooltip and the commit hover card. */
	overlays: Overlays.Model,
	/** Whether traces ever arrived: an empty window is then quiet, not unset up. */
	presence: SignalPresenceData.schema,
})
export type Model = typeof Model.Type
