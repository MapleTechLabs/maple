import { CodeReviewAnalytics } from "@maple/domain/http"
import { Schema } from "effect"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { CodeReviewSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import { Frame } from "../kit/frame"
import { ResponseCache } from "../kit/page-steps"

// `/code-review`: the analytics tab.

export const Model = Schema.Struct({
	search: CodeReviewSearch,
	frame: Frame,
	/** The page's `codeReview.analytics` read. */
	analytics: KeyedSchema(CodeReviewAnalytics, LoadFailure),
	/** The filters' author list: the same read without the author (one request while none is picked). */
	authors: KeyedSchema(CodeReviewAnalytics, LoadFailure),
	/** Retained answers by key, so a filter undone within a minute is not fetched again. */
	cache: ResponseCache(CodeReviewAnalytics),
	/** `VolumeCard`'s metric and `IssuesCard`'s severity (component state). */
	volumeSelect: Select.Model,
	severitySelect: Select.Model,
	volumeChart: Chart.Model,
	issuesChart: Chart.Model,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
})
export type Model = typeof Model.Type
