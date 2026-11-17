import { CloudFindingDetailQuery, type CloudFindingsListRequest } from "@maple/domain/http"
import { readClock } from "@maple/views/data/timing"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import { SecurityCloudSearch } from "../../../route/search"
import { listRequestOf } from "./derive"
import { Message } from "./model"

// The Cloud tab's reads on the api Worker. Names start with `SecurityApi` (and the clock's with
// `ReadSecurity`) so the lab drops them.

export const PAGE_LIMIT = 50

export const ReadCloudClock = readClock("ReadSecurityCloudClock", Message.ReadClock)

export const FetchOverview = Command.define("SecurityApiCloudOverview", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchOverview],
	execute: ({ key }) =>
		Effect.flatMap(MapleInternalApiClient, (api) => api.cloudSecurity.overview()).pipe(
			settleTo((result) => Message.CompletedFetchOverview({ key, result })),
		),
})

const listFindings = (request: CloudFindingsListRequest) =>
	Effect.flatMap(MapleInternalApiClient, (api) => api.cloudSecurity.listFindings({ payload: request }))

export const FetchFirstPage = Command.define("SecurityApiCloudFirstPage", {
	args: { key: Schema.String, search: SecurityCloudSearch },
	messages: [Message.CompletedFetchFirstPage],
	execute: ({ key, search }) =>
		listFindings({ ...listRequestOf(search), limit: PAGE_LIMIT }).pipe(
			settleTo((result) => Message.CompletedFetchFirstPage({ key, result })),
		),
})

export const FetchNextPage = Command.define("SecurityApiCloudNextPage", {
	args: {
		key: Schema.String,
		generation: Schema.Number,
		search: SecurityCloudSearch,
		offset: Schema.Number,
	},
	messages: [Message.CompletedFetchNextPage],
	execute: ({ key, generation, search, offset }) =>
		listFindings({ ...listRequestOf(search), limit: PAGE_LIMIT, offset }).pipe(
			settleTo((result) => Message.CompletedFetchNextPage({ key, generation, offset, result })),
		),
})

export const FetchFinding = Command.define("SecurityApiCloudFinding", {
	args: { key: Schema.String, query: CloudFindingDetailQuery },
	messages: [Message.CompletedFetchFinding],
	execute: ({ key, query }) =>
		Effect.flatMap(MapleInternalApiClient, (api) => api.cloudSecurity.finding({ query })).pipe(
			settleTo((result) => Message.CompletedFetchFinding({ key, result })),
		),
})
