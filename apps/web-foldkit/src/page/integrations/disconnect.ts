import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../data/load-failure"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { Message, type StatusName } from "./message"

// Each integration's disconnect: the confirmation copy, the mutation, its toasts, and the status
// reads its `reactivityKeys` refresh (`useIntegrationDisconnect` + `ConfirmDialog`).

export interface DisconnectSpec {
	readonly title: string
	readonly description: string
	readonly confirmLabel: string
	readonly success: string
	readonly error: string
	readonly refresh: ReadonlyArray<StatusName>
}

export const DISCONNECTS = new Map<string, DisconnectSpec>([
	[
		"hazel",
		{
			title: "Disconnect Hazel",
			description: "Alerts routed to Hazel stop being delivered until you reconnect.",
			confirmLabel: "Disconnect",
			success: "Hazel disconnected",
			error: "Failed to disconnect Hazel",
			refresh: ["hazel"],
		},
	],
])

const mutation = (integration: string) =>
	Effect.gen(function* () {
		const internal = yield* MapleInternalApiClient
		switch (integration) {
			case "hazel":
				return yield* Effect.asVoid(internal.integrations.hazelDisconnect())
			default:
				return yield* Effect.void
		}
	})

export const Disconnect = Command.define("DisconnectIntegration", {
	args: { integration: Schema.String },
	messages: [Message.CompletedDisconnect],
	execute: ({ integration }) =>
		mutation(integration).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedDisconnect({ integration, failure: toLoadFailure(error) }),
				onSuccess: () => Message.CompletedDisconnect({ integration, failure: null }),
			}),
		),
})
