import { VcsCommitDetailResponse, VcsCommitRangeResponse } from "@maple/domain/http"
import { V2ErrorIssue } from "@maple/domain/http/v2"
import { Schema } from "effect"
import * as Overlays from "../overlays"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { ReleaseSearch } from "../../../route/search"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { ReleaseRow, ReleasesData, TimelineBucket } from "../list/model"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { CommitData, DetailPoint } from "../../services/detail/model"

// `/releases/$commitSha`: the deploy across every service it reached.

/** `getReleaseDetail`: the service's versions and timeline, this version's and the baseline's series. */
export const ReleaseDetail = Schema.Struct({
	versions: Schema.Array(ReleaseRow),
	timeline: Schema.Array(TimelineBucket),
	points: Schema.Array(DetailPoint),
	baselinePoints: Schema.Array(DetailPoint),
	errorFingerprints: Schema.Array(
		Schema.Struct({ fingerprintHash: Schema.String, count: Schema.Number, firstSeen: Schema.String }),
	),
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
})
export type ReleaseDetail = typeof ReleaseDetail.Type

export const Model = Schema.Struct({
	commitSha: Schema.String,
	search: ReleaseSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
	/** `commitQueryAtom(sha)`: the title's commit message and author. */
	commit: KeyedSchema(VcsCommitDetailResponse, LoadFailure),
	releases: KeyedSchema(ReleasesData, LoadFailure),
	/** `ReleaseChangeset`: the commits since the version it replaced. */
	changeset: KeyedSchema(Schema.Array(VcsCommitRangeResponse), LoadFailure),
	/** `DeployIssues`: issues introduced since the deploy. */
	issues: KeyedSchema(Schema.Array(V2ErrorIssue), LoadFailure),
	timePicker: TimeRangePicker.Model,
	/** The health pills' tooltip and the commit hover card. */
	overlays: Overlays.Model,
	/** `ReleaseBody` (`?service=`): this version on one service, against the one it replaced. */
	detail: KeyedSchema(ReleaseDetail, LoadFailure),
	series: Schema.Literals(["version", "others"]),
	/** `ReleaseIssuesPanel`: the issue documents of the fingerprints this version carried. */
	serviceIssues: KeyedSchema(Schema.Array(V2ErrorIssue), LoadFailure),
	/** The metrics grid: each card's focus and plot, by chart id; its theme and plotting runtime. */
	charts: Schema.Record(Schema.String, Chart.Model),
	themeColors: Schema.NullOr(ThemeColors),
	/** `null` until a service body asks for it. */
	chartRuntime: Schema.NullOr(ChartRuntime),
	/** The commit markers' subjects (`commitQueryAtom` per marker sha other than this release's). */
	markerCommits: Schema.Record(Schema.String, CommitData.schema),
})
export type Model = typeof Model.Type
