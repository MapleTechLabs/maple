import { CloudflareUsageResponse } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { ChartRuntime } from "../../charts/chart-runtime"
import * as ToggleGroup from "../../ui/toggle-group"
import { KeyedSchema } from "../../data/keyed"
import { LoadFailure, toLoadFailure } from "../../data/load-failure"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { Message } from "./message"

// `CloudflareAccountCard` and the Cloudflare half of `IntegrationConnectProvider`: state and reads.

export const ZoneSortKey = Schema.Literals(["name", "status", "requests"])
export type ZoneSortKey = typeof ZoneSortKey.Type

export const initCloudflareCard = () => ({
	usage: { key: null, data: AsyncData.Idle() },
	isPrimed: false,
	isPriming: false,
	zoneSearch: "",
	zoneFilter: ToggleGroup.init({ label: "Filter zones by status", values: ["all"] }),
	zoneSort: { key: "requests" as const, dir: "desc" as const },
	workersExpanded: false,
	chartRuntime: ChartRuntime.Loading(),
})

export const CloudflareCardModel = Schema.Struct({
	/** `retainedInternalQuery("integrations", "cloudflareUsage")`. */
	usage: KeyedSchema(CloudflareUsageResponse, LoadFailure),
	/** Whether this attempt's prime already ran against a live grant (`primedRef`). */
	isPrimed: Schema.Boolean,
	isPriming: Schema.Boolean,
	/** `CloudflareZoneBoard`: name search, status chips (single-select), sort. */
	zoneSearch: Schema.String,
	zoneFilter: ToggleGroup.Model,
	zoneSort: Schema.Struct({ key: ZoneSortKey, dir: Schema.Literals(["asc", "desc"]) }),
	/** `CloudflareWorkersCard`'s "View all". */
	workersExpanded: Schema.Boolean,
	chartRuntime: ChartRuntime,
})
export type CloudflareCardModel = typeof CloudflareCardModel.Type

export const LoadCloudflareUsage = Command.define("LoadIntegrationsCloudflareUsage", {
	args: { key: Schema.String },
	messages: [Message.CompletedLoadCloudflareUsage],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.integrations.cloudflareUsage()
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedLoadCloudflareUsage({ key, result })),
		),
})

/** `cloudflarePrime`: discovery and a first poll now instead of on the next cron tick. */
export const PrimeCloudflare = Command.define("PrimeCloudflare", {
	messages: [Message.CompletedCloudflarePrime],
	execute: Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		return yield* client.integrations.cloudflarePrime()
	}).pipe(
		Effect.match({
			onFailure: () => Message.CompletedCloudflarePrime({ isConnected: false, isOk: false }),
			onSuccess: (response) =>
				Message.CompletedCloudflarePrime({ isConnected: response.connected, isOk: true }),
		}),
	),
})
