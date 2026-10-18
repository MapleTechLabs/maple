import { VcsCommitDetailResponse, VcsCommitRangeResponse } from "@maple/domain/http"
import { V2ErrorIssue } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { ReleaseSearch } from "../../../route/search"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { ReleasesData } from "../list/model"

// `/releases/$commitSha` (apps/web/src/routes/releases/$commitSha.tsx): the deploy across every
// service it reached (`ReleaseDeployOverview`).

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
})
export type Model = typeof Model.Type
