import { RailwayConnectRequest, type RailwayIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { displayError, isUnexpectedError } from "@maple/web-data/lib/error-messages"
import { Effect, Schema, Array as Arr } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure, toLoadFailure } from "@maple/views/data/load-failure"
import { IntegrationStatuses } from "../../../../data/integration-statuses"
import { MapleInternalApiClient } from "../../../../platform/api-clients"
import * as Field from "@maple/views/ui/field"

export const RailwayCardModel = Schema.Struct({
	/** The token form's state (the shape the infra page's form shares). */
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

/** The Railway module's own messages; the hub carries them in `GotRailwayMessage`. */
export const RailwayMessage = defineMessageUnion({
	GotTokenMessage: { message: Field.Message },
	SubmittedToken: {},
	SucceededConnect: { title: Schema.String, description: Schema.String },
	FailedConnect: { error: Schema.String },
	ClickedSync: {},
	CompletedSync: { failure: Schema.NullOr(LoadFailure) },
	ClickedRotate: {},
	ClickedRotateCancel: {},
	/** Every 15 s while environments wait for their first sync. */
	TickedSettle: {},
})
export type RailwayMessage = typeof RailwayMessage.Type

/** The hub's status read for Railway, shared with the sidebar. */
export const RAILWAY_STATUS_READ = {
	name: "LoadIntegrationsRailwayStatus",
	read: (refresh: boolean) =>
		Effect.flatMap(IntegrationStatuses, (statuses) => statuses.railway({ refresh })),
}

/** Environments the poller has not completed a first sync for yet (and has not failed on). */
export const unsyncedEnvironments = (status: RailwayIntegrationStatus): number =>
	Arr.filter(
		status.environments,
		(environment) => environment.lastSyncedAt === null && environment.lastError === null,
	).length

export const connectedToastOf = (status: RailwayIntegrationStatus, mode: "connect" | "rotate") => {
	const synced = Arr.filter(status.environments, (environment) => environment.lastSyncedAt !== null).length
	const failed = Arr.filter(
		status.environments,
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
	messages: [RailwayMessage.SucceededConnect, RailwayMessage.FailedConnect],
	execute: ({ token, mode }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const status = yield* client.integrations.railwayConnect({
				payload: new RailwayConnectRequest({ token }),
			})
			const toast = connectedToastOf(status, mode)
			return RailwayMessage.SucceededConnect({ title: toast.title, description: toast.description })
		}).pipe(
			Effect.catch((error) => {
				const presentation = displayError(error)
				return Effect.succeed(
					RailwayMessage.FailedConnect({
						error: isUnexpectedError(presentation)
							? "Couldn't connect Railway."
							: presentation.message,
					}),
				)
			}),
		),
})

export const SyncRailway = Command.define("SyncRailway", {
	messages: [RailwayMessage.CompletedSync],
	execute: Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		yield* client.integrations.railwaySync()
	}).pipe(
		Effect.match({
			onFailure: (error) => RailwayMessage.CompletedSync({ failure: toLoadFailure(error) }),
			onSuccess: () => RailwayMessage.CompletedSync({ failure: null }),
		}),
	),
})
