import { RailwayConnectRequest } from "@maple/domain/http"
import { Option, Schema } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import type { LoadFailure } from "../../data/load-failure"
import * as Field from "../../ui/field"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { ConnectRailwayToken, type RailwayCardModel, SyncRailway } from "./railway"
import { chain, requestStatus } from "./update-status"

// `RailwayIntegrationCard`'s state changes.

type Return = PageReturn<Model, Message>

const decodeConnectRequest = Schema.decodeUnknownOption(RailwayConnectRequest)

const withCard = (model: Model, card: Partial<RailwayCardModel>): Model => ({
	...model,
	railwayCard: { ...model.railwayCard, ...card },
})

const toast = (model: Model, type: "success" | "error", title: string, description = ""): Return => ({
	model,
	outMessage: PageOutMessage.RequestedToast({ type, title, description }),
})

const isAuthFailed = (model: Model): boolean =>
	Option.match(AsyncData.getData(model.statuses.railway.data), {
		onNone: () => false,
		onSome: (status) => status.authFailed,
	})

export const gotToken = (model: Model, message: Field.Message): Return => {
	const step = Field.update(model.railwayCard.connect.token, message)
	return {
		model: withCard(model, { connect: { ...model.railwayCard.connect, token: step.model } }),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			Message.GotRailwayTokenMessage({ message: inner }),
		),
	}
}

export const submittedToken = (model: Model): Return => {
	const connect = model.railwayCard.connect
	if (connect.isSubmitting) return { model }
	const mode = model.railwayCard.isRotating || isAuthFailed(model) ? "rotate" : "connect"
	return Option.match(decodeConnectRequest({ token: connect.token.value.trim() }), {
		onNone: () => ({ model }),
		onSome: (request) => ({
			model: withCard(model, { connect: { ...connect, isSubmitting: true, error: null } }),
			commands: [ConnectRailwayToken({ token: request.token, mode })],
		}),
	})
}

/** The toast, a cleared form, the form closed (`onSaved`), and the status re-read. */
export const succeededConnect = (
	model: Model,
	context: PageContext,
	title: string,
	description: string,
): Return =>
	chain(
		withCard(model, {
			connect: { token: Field.init(), isSubmitting: false, error: null },
			isRotating: false,
		}),
		[
			(next) => toast(next, "success", title, description),
			(next) => requestStatus(next, context, "railway", "Supersede"),
		],
	)

export const failedConnect = (model: Model, error: string): Return => ({
	model: withCard(model, { connect: { ...model.railwayCard.connect, isSubmitting: false, error } }),
})

export const clickedSync = (model: Model): Return =>
	model.railwayCard.isSyncing
		? { model }
		: { model: withCard(model, { isSyncing: true }), commands: [SyncRailway()] }

export const completedSync = (model: Model, context: PageContext, failure: LoadFailure | null): Return => {
	const settled = withCard(model, { isSyncing: false })
	return failure === null
		? requestStatus(settled, context, "railway", "Supersede")
		: toast(settled, "error", "Couldn't sync Railway", failure.message)
}

export const setRotating = (model: Model, isRotating: boolean): Return => ({
	model: withCard(model, { isRotating }),
})
