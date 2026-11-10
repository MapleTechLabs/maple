import { readClock } from "@maple/views/data/timing"
import { RecommendationIssueId } from "@maple/domain/http"
import { V2AttributeMappingCreateParams } from "@maple/domain/http/v2"
import { collectV2Pages } from "@maple/web-data/lib/v2-pagination"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { MapleApiV2Client } from "../../platform/api-clients"
import { Message } from "./message"

const PAGE_LIMIT = 100
const page = (cursor: string | undefined) => ({
	query: { limit: PAGE_LIMIT, ...(cursor !== undefined ? { cursor } : undefined) },
})

export const ReadRecommendationClock = readClock("ReadRecommendationClock", Message.ReadClock)

export const FetchRecommendations = Command.define("FetchRecommendations", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchList],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* collectV2Pages((cursor) => client.instrumentationRecommendations.list(page(cursor)))
		}).pipe(settleTo((result) => Message.CompletedFetchList({ key, result }))),
})

export const FetchAttributeMappings = Command.define("FetchRecommendationAttributeMappings", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchMappings],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* collectV2Pages((cursor) => client.attributeMappings.list(page(cursor)))
		}).pipe(settleTo((result) => Message.CompletedFetchMappings({ key, result }))),
})

export const CreateMapping = Command.define("CreateRecommendationMapping", {
	args: { payload: V2AttributeMappingCreateParams },
	messages: [Message.CompletedApply],
	execute: ({ payload }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* client.attributeMappings.create({ payload })
		}).pipe(settleTo((result) => Message.CompletedApply({ result }))),
})

export const DismissRecommendation = Command.define("DismissRecommendation", {
	args: { id: RecommendationIssueId },
	messages: [Message.CompletedDismiss],
	execute: ({ id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			yield* client.instrumentationRecommendations.dismiss({ params: { id } })
		}).pipe(settleTo((result) => Message.CompletedDismiss({ result }))),
})

export const ReopenRecommendation = Command.define("ReopenRecommendation", {
	args: { id: RecommendationIssueId },
	messages: [Message.CompletedReopen],
	execute: ({ id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			yield* client.instrumentationRecommendations.reopen({ params: { id } })
		}).pipe(settleTo((result) => Message.CompletedReopen({ result }))),
})
