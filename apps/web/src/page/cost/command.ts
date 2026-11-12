import { CostBreakdownSortBy, CostFilters, OpenRouterKeyUpdateRequest } from "@maple/domain/http"
import { VcsInstallationId } from "@maple/domain/vcs"
import { reloadSpin } from "@maple/views/data/timing"
import { settleTo } from "@maple/views/data/load-failure"
import {
	getCostBreakdown,
	getCostSources,
	getCostTimeseries,
	getCostTotals,
} from "@maple/web-data/warehouse/cost"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { readGrants } from "../../data/session-tenant"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { COST_GROUP_BYS } from "../../route/search"
import { resolveWindowCommand } from "../kit/time-frame"
import { Message } from "./message"

// Each read answers with the key it was sent under; its input is what the key was built from.

export const ResolveWindow = resolveWindowCommand("ResolveCostWindow", Message.CompletedResolveWindow)

export const CompleteReloadSpin = reloadSpin("CompleteCostReloadSpin", Message.CompletedReloadSpin)

/** The window and the filters every cost read carries. */
const WindowFields = {
	startTime: Schema.String,
	endTime: Schema.String,
	filters: Schema.optional(CostFilters),
}
export const WindowInput = Schema.Struct(WindowFields)
export type WindowInput = typeof WindowInput.Type

export const TimeseriesInput = Schema.Struct({
	...WindowFields,
	groupBy: Schema.Literals(COST_GROUP_BYS),
	limit: Schema.Number,
})
export type TimeseriesInput = typeof TimeseriesInput.Type

export const BreakdownInput = Schema.Struct({
	...WindowFields,
	groupBy: Schema.Literals(COST_GROUP_BYS),
	sortBy: CostBreakdownSortBy,
	limit: Schema.Number,
})
export type BreakdownInput = typeof BreakdownInput.Type

/** An unset filter stays out of the body: an `undefined` key would encode as null. */
const windowOf = (input: WindowInput) => ({
	startTime: input.startTime,
	endTime: input.endTime,
	...(input.filters === undefined ? undefined : { filters: input.filters }),
})

export const FetchCostSources = Command.define("FetchCostSources", {
	args: { key: Schema.String },
	messages: [Message.CompletedLoadSources],
	execute: ({ key }) =>
		getCostSources().pipe(settleTo((result) => Message.CompletedLoadSources({ key, result }))),
})

export const FetchCostTotals = Command.define("FetchCostTotals", {
	args: { key: Schema.String, input: WindowInput },
	messages: [Message.CompletedLoadTotals],
	execute: ({ key, input }) =>
		getCostTotals({ data: windowOf(input) }).pipe(
			settleTo((result) => Message.CompletedLoadTotals({ key, result })),
		),
})

export const FetchCostTimeseries = Command.define("FetchCostTimeseries", {
	args: { key: Schema.String, input: TimeseriesInput },
	messages: [Message.CompletedLoadTimeseries],
	execute: ({ key, input }) =>
		getCostTimeseries({
			data: { ...windowOf(input), groupBy: input.groupBy, limit: input.limit },
		}).pipe(settleTo((result) => Message.CompletedLoadTimeseries({ key, result }))),
})

export const FetchCostBreakdown = Command.define("FetchCostBreakdown", {
	args: { key: Schema.String, input: BreakdownInput },
	messages: [Message.CompletedLoadBreakdown],
	execute: ({ key, input }) =>
		getCostBreakdown({
			data: { ...windowOf(input), groupBy: input.groupBy, sortBy: input.sortBy, limit: input.limit },
		}).pipe(settleTo((result) => Message.CompletedLoadBreakdown({ key, result }))),
})

export const ReadCostGrants = Command.define("ReadCostGrants", {
	messages: [Message.CompletedReadGrants],
	execute: Effect.map(readGrants, (grants) => Message.CompletedReadGrants({ grants })),
})

/** Saves the org's OpenRouter management key, which makes (or keeps) its cost source. */
export const SaveOpenRouterCostKey = Command.define("SaveOpenRouterCostKey", {
	args: { apiKey: Schema.String },
	messages: [Message.CompletedSaveKey],
	execute: ({ apiKey }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.openRouterCost.set({ payload: new OpenRouterKeyUpdateRequest({ apiKey }) }),
		).pipe(settleTo((result) => Message.CompletedSaveKey({ result }))),
})

export const RemoveOpenRouterCostKey = Command.define("RemoveOpenRouterCostKey", {
	messages: [Message.CompletedRemoveKey],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.openRouterCost.remove()).pipe(
		settleTo((result) => Message.CompletedRemoveKey({ result })),
	),
})

/** The org's GitHub installations, with which can supply cost. */
export const FetchGithubCostInstallations = Command.define("FetchGithubCostInstallations", {
	args: { request: Schema.Number },
	messages: [Message.CompletedLoadGithubInstallations],
	execute: ({ request }) =>
		Effect.flatMap(MapleInternalApiClient, (client) => client.githubCost.list()).pipe(
			settleTo((result) => Message.CompletedLoadGithubInstallations({ request, result })),
		),
})

/** Makes the installation's cost source, once GitHub lets Maple read its billing report. */
export const AddGithubCostSource = Command.define("AddGithubCostSource", {
	args: { installationId: VcsInstallationId },
	messages: [Message.CompletedAddGithubSource],
	execute: ({ installationId }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.githubCost.add({ params: { installationId } }),
		).pipe(settleTo((result) => Message.CompletedAddGithubSource({ installationId, result }))),
})

export const RemoveGithubCostSource = Command.define("RemoveGithubCostSource", {
	args: { installationId: VcsInstallationId },
	messages: [Message.CompletedRemoveGithubSource],
	execute: ({ installationId }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.githubCost.remove({ params: { installationId } }),
		).pipe(settleTo((result) => Message.CompletedRemoveGithubSource({ result }))),
})
