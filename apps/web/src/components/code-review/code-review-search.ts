import { Schema } from "effect"
import {
	PrReviewCategory,
	PrReviewFindingStatus,
	PrReviewId,
	PrReviewSeverity,
	VcsRepositoryId,
} from "@maple/domain/http"

import { TimeRangeSearchFields, type TimeRangeSearch } from "@/components/time-range-picker/search"

// The routes' search schemas, apart from the layout: a route's `validateSearch` is in the startup
// bundle, and importing it from the layout would pull the whole app shell in with it.

/** Reviews are slow-moving: a month is the window that has something in it. */
export const CODE_REVIEW_DEFAULT_PRESET = "30d"
export const CODE_REVIEW_MAX_RANGE_SECONDS = 365 * 24 * 60 * 60

/** The filters the Analytics and Pull requests tabs share, carried between them. */
export const CodeReviewSearchFields = {
	repo: Schema.optional(VcsRepositoryId),
	author: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
}

export const CodeReviewIssuesSearchFields = {
	...CodeReviewSearchFields,
	severity: Schema.optional(PrReviewSeverity),
	category: Schema.optional(PrReviewCategory),
	state: Schema.optional(PrReviewFindingStatus),
	review: Schema.optional(PrReviewId),
}

export const CodeReviewListSearchFields = {
	...CodeReviewSearchFields,
	status: Schema.optional(Schema.Literals(["completed", "failed", "skipped", "running", "queued"])),
	review: Schema.optional(PrReviewId),
}

export interface CodeReviewSearch extends TimeRangeSearch {
	repo?: VcsRepositoryId
	author?: string
}
