import { CloudflareUsageResponse } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { KeyedSchema } from "../../data/keyed"
import { LoadFailure, toLoadFailure } from "../../data/load-failure"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { Message } from "./message"

// `CloudflareAccountCard` and the Cloudflare half of `IntegrationConnectProvider`: state and reads.

export const CloudflareCardModel = Schema.Struct({
	/** `retainedInternalQuery("integrations", "cloudflareUsage")`. */
	usage: KeyedSchema(CloudflareUsageResponse, LoadFailure),
	/** Whether this attempt's prime already ran against a live grant (`primedRef`). */
	isPrimed: Schema.Boolean,
	isPriming: Schema.Boolean,
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
