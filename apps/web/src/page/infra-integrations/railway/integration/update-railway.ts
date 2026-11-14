import { RailwayConnectRequest, type RailwayIntegrationStatus } from "@maple/domain/http"
import { Option, Schema, String as Str } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Field from "@maple/views/ui/field"
import { HubRequest, type ProviderEnv, type ProviderReturn } from "../../../integrations/provider"
import { ConnectRailwayToken, type RailwayCardModel, RailwayMessage, SyncRailway } from "./railway"

type Env = ProviderEnv<RailwayIntegrationStatus>
type Return = ProviderReturn<RailwayCardModel, RailwayMessage>

const decodeConnectRequest = Schema.decodeUnknownOption(RailwayConnectRequest)

const isAuthFailed = (env: Env): boolean =>
	Option.match(AsyncData.getData(env.status.data), {
		onNone: () => false,
		onSome: (status) => status.authFailed,
	})

const gotToken = (model: RailwayCardModel, message: Field.Message): Return => {
	const step = Field.update(model.connect.token, message)
	return {
		model: { ...model, connect: { ...model.connect, token: step.model } },
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			RailwayMessage.GotTokenMessage({ message: inner }),
		),
	}
}

const submittedToken = (model: RailwayCardModel, env: Env): Return => {
	const connect = model.connect
	if (connect.isSubmitting) return { model }
	const mode = model.isRotating || isAuthFailed(env) ? "rotate" : "connect"
	return Option.match(decodeConnectRequest({ token: Str.trim(connect.token.value) }), {
		onNone: () => ({ model }),
		onSome: (request) => ({
			model: { ...model, connect: { ...connect, isSubmitting: true, error: null } },
			commands: [ConnectRailwayToken({ token: request.token, mode })],
		}),
	})
}

export const update = (model: RailwayCardModel, message: RailwayMessage, env: Env): Return =>
	RailwayMessage.match<Return>(message, {
		GotTokenMessage: ({ message: child }) => gotToken(model, child),
		SubmittedToken: () => submittedToken(model, env),
		// The toast, a cleared form, the form closed, and the status re-read.
		SucceededConnect: ({ title, description }) => ({
			model: {
				...model,
				connect: { token: Field.init(), isSubmitting: false, error: null },
				isRotating: false,
			},
			requests: [HubRequest.toast("success", title, description), HubRequest.readStatus("Supersede")],
		}),
		FailedConnect: ({ error }) => ({
			model: { ...model, connect: { ...model.connect, isSubmitting: false, error } },
		}),
		ClickedSync: () =>
			model.isSyncing ? { model } : { model: { ...model, isSyncing: true }, commands: [SyncRailway()] },
		CompletedSync: ({ failure }) => ({
			model: { ...model, isSyncing: false },
			requests: [
				failure === null
					? HubRequest.readStatus("Supersede")
					: HubRequest.toast("error", "Couldn't sync Railway", failure.message),
			],
		}),
		ClickedRotate: () => ({ model: { ...model, isRotating: true } }),
		ClickedRotateCancel: () => ({ model: { ...model, isRotating: false } }),
		TickedSettle: () => ({ model, requests: [HubRequest.readStatus("Refresh")] }),
	})
