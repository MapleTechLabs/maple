import {
	CloudFindingDetailResponse,
	CloudFindingsListResponse,
	CloudSecurityOverviewResponse,
} from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { SecurityCloudFindingSearch, SecurityCloudSearch } from "../../../route/search"
import { laterPagesFields } from "../../kit/infinite-pages"

// `/security/cloud` and `/security/cloud/finding` as one page instance: the AWS and Google Cloud
// findings list under the URL's filters, and one finding's detail. Both read the overview that
// says which clouds are connected and which services answer.

export type Search = SecurityCloudSearch
export type FindingSearch = SecurityCloudFindingSearch

export const Overview = CloudSecurityOverviewResponse
export type Overview = typeof Overview.Type
export const FindingsPage = CloudFindingsListResponse
export type FindingsPage = typeof FindingsPage.Type
export const FindingDetail = CloudFindingDetailResponse
export type FindingDetail = typeof FindingDetail.Type

export const LaterPages = Schema.Struct({
	key: Schema.NullOr(Schema.String),
	...laterPagesFields(FindingsPage),
})
export type LaterPages = typeof LaterPages.Type

export const Screen = Schema.Literals(["list", "finding"])
export type Screen = typeof Screen.Type

/** The filters a select sets; the search is typed and applied on Enter. */
export const SelectFilter = Schema.Literals(["status", "severity", "provider", "source", "account", "region"])
export type SelectFilter = typeof SelectFilter.Type

export const Model = Schema.Struct({
	screen: Screen,
	search: SecurityCloudSearch,
	findingSearch: SecurityCloudFindingSearch,
	nowMs: Schema.Finite,
	overview: KeyedSchema(Overview, LoadFailure),
	firstPage: KeyedSchema(FindingsPage, LoadFailure),
	laterPages: LaterPages,
	detail: KeyedSchema(FindingDetail, LoadFailure),
	/** The search field as typed; the URL holds what was applied. */
	searchText: Schema.String,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Finite },
	CompletedFetchOverview: { key: Schema.String, result: Schema.Result(Overview, LoadFailure) },
	CompletedFetchFirstPage: { key: Schema.String, result: Schema.Result(FindingsPage, LoadFailure) },
	CompletedFetchNextPage: {
		key: Schema.String,
		generation: Schema.Number,
		/** The offset the page was asked from: an answer for another one is not the next page. */
		offset: Schema.Number,
		result: Schema.Result(FindingsPage, LoadFailure),
	},
	CompletedFetchFinding: { key: Schema.String, result: Schema.Result(FindingDetail, LoadFailure) },
	ClickedRetry: {},
	ClickedLoadMore: {},
	ChangedFilter: { filter: SelectFilter, value: Schema.String },
	ChangedSearchText: { value: Schema.String },
	SubmittedSearch: {},
	ClearedSearch: {},
	ClickedClearFilters: {},
})
export type Message = typeof Message.Type
