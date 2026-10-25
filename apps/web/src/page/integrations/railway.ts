import { RailwayConnectRequest, type RailwayIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { displayError, isUnexpectedError } from "@maple/web-data/lib/error-messages"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../data/load-failure"
import { MapleInternalApiClient } from "../../platform/api-clients"
import * as Field from "../../ui/field"
import { Message } from "./message"

// `RailwayIntegrationCard`: state and writes.

export const RailwayCardModel = Schema.Struct({
	/** `RailwayTokenForm`'s state (the shape the infra page's form shares). */
	connect: Schema.Struct({
		token: Field.Model,
		isSubmitting: Schema.Boolean,
		error: Schema.NullOr(Schema.String),
	}),
	isRotating: Schema.Boolean,
	isSyncing: Schema.Boolean,
})
export type RailwayCardModel = typeof RailwayCardModel.Type

export const initRailwayCard = (): RailwayCardModel => ({
	connect: { token: Field.init(), isSubmitting: false, error: null },
	isRotating: false,
	isSyncing: false,
})

/** Environments the poller has not completed a first sync for yet (and has not failed on). */
export const unsyncedEnvironments = (status: RailwayIntegrationStatus): number =>
	status.environments.filter(
		(environment) => environment.lastSyncedAt === null && environment.lastError === null,
	).length

/** `connectedToast`. */
export const connectedToastOf = (status: RailwayIntegrationStatus, mode: "connect" | "rotate") => {
	const synced = status.environments.filter((environment) => environment.lastSyncedAt !== null).length
	const failed = status.environments.filter(
		(environment) => environment.lastSyncedAt === null && environment.lastError !== null,
	).length
	const queued = unsyncedEnvironments(status)
	return {
		title: mode === "rotate" ? "Railway token updated" : "Railway connected",
		description:
			status.environments.length === 0
				? "This token can't see any projects yet."
				: failed > 0
					? `${countLabel(synced, "environment")} synced, ${failed} failed. The rows below say why.`
					: queued === 0
						? `Pulled the last hour of metrics for ${countLabel(synced, "environment")}.`
						: `${countLabel(synced, "environment")} synced, ${queued} more within 5 minutes.`,
	}
}

export const ConnectRailwayToken = Command.define("ConnectRailwayFromIntegrations", {
	args: { token: Schema.String, mode: Schema.Literals(["connect", "rotate"]) },
	messages: [Message.SucceededRailwayConnect, Message.FailedRailwayConnect],
	execute: ({ token, mode }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const status = yield* client.integrations.railwayConnect({
				payload: new RailwayConnectRequest({ token }),
			})
			const toast = connectedToastOf(status, mode)
			return Message.SucceededRailwayConnect({ title: toast.title, description: toast.description })
		}).pipe(
			Effect.catch((error) => {
				const presentation = displayError(error)
				return Effect.succeed(
					Message.FailedRailwayConnect({
						error: isUnexpectedError(presentation)
							? "Failed to connect Railway."
							: presentation.message,
					}),
				)
			}),
		),
})

export const SyncRailway = Command.define("SyncRailway", {
	messages: [Message.CompletedRailwaySync],
	execute: Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		yield* client.integrations.railwaySync()
	}).pipe(
		Effect.match({
			onFailure: (error) => Message.CompletedRailwaySync({ failure: toLoadFailure(error) }),
			onSuccess: () => Message.CompletedRailwaySync({ failure: null }),
		}),
	),
})
