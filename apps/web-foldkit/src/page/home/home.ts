import { CloudflareIntegrationStatus } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { AsyncData, Command, Submodel, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { MapleInternalApiClient } from "../../platform/api-clients"

// MODEL

/** Why the shell's boot request failed. */
export const LoadFailure = Schema.Literals(["Unavailable", "Unreachable"])
export type LoadFailure = typeof LoadFailure.Type

const CloudflareStatusData = AsyncData.Schema(CloudflareIntegrationStatus, LoadFailure)

/** S1 placeholder for `/`: proves the session reaches the API through one boot request. */
export const Model = Schema.Struct({ cloudflareStatus: CloudflareStatusData.schema })
export type Model = typeof Model.Type

export const init = (): Model => ({ cloudflareStatus: CloudflareStatusData.Idle() })

// MESSAGE

export const Message = defineMessageUnion({
	SucceededFetchCloudflareStatus: { status: CloudflareIntegrationStatus },
	FailedFetchCloudflareStatus: { failure: LoadFailure },
})
export type Message = typeof Message.Type

// COMMAND

/** `integrations.cloudflareStatus`: the sidebar asks for it on every boot (`useInfraSurfaces`). */
export const FetchCloudflareStatus = Command.define("FetchCloudflareStatus", {
	messages: [Message.SucceededFetchCloudflareStatus, Message.FailedFetchCloudflareStatus],
	execute: Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		const status = yield* client.integrations.cloudflareStatus()
		return Message.SucceededFetchCloudflareStatus({ status })
	}).pipe(
		Effect.catchTag("HttpClientError", () =>
			Effect.succeed(Message.FailedFetchCloudflareStatus({ failure: "Unreachable" })),
		),
		Effect.catch(() => Effect.succeed(Message.FailedFetchCloudflareStatus({ failure: "Unavailable" }))),
	),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, MapleInternalApiClient>

/** Entering `/` signed in: load unless a load already ran. */
export const load = (model: Model): UpdateReturn =>
	AsyncData.match(model.cloudflareStatus, {
		onIdle: () => ({ model: { cloudflareStatus: CloudflareStatusData.Loading() }, commands: [FetchCloudflareStatus()] }),
		onLoading: () => ({ model }),
		onRefreshing: () => ({ model }),
		onFailure: () => ({ model: { cloudflareStatus: CloudflareStatusData.Loading() }, commands: [FetchCloudflareStatus()] }),
		onStale: () => ({ model }),
		onSuccess: () => ({ model }),
	})

export const update = (_model: Model, message: Message) =>
	Message.match<UpdateReturn>(message, {
		SucceededFetchCloudflareStatus: ({ status }) => ({
			model: { cloudflareStatus: CloudflareStatusData.Success({ data: status }) },
		}),
		FailedFetchCloudflareStatus: ({ failure }) => ({
			model: { cloudflareStatus: CloudflareStatusData.Failure({ error: failure }) },
		}),
	})

// VIEW

const statusText = (model: Model): string =>
	AsyncData.match(model.cloudflareStatus, {
		onIdle: () => "Waiting for the session",
		onLoading: () => "Loading Cloudflare integration status",
		onRefreshing: () => "Refreshing Cloudflare integration status",
		onFailure: (failure) => `Cloudflare integration status failed: ${failure}`,
		onStale: ({ error }) => `Cloudflare integration status is stale: ${error}`,
		onSuccess: (status) => `Cloudflare integration: ${status.connected ? "connected" : "not connected"}`,
	})

export const view = Submodel.defineView<Model, Message>((model, h) =>
	h.p([h.Class("text-muted-foreground text-sm"), h.DataAttribute("testid", "boot-request")], [statusText(model)]),
)
