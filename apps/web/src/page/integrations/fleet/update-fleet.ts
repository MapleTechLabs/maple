import type { FleetIntegrationStatus } from "@maple/domain/http"
import { Option } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Field from "@maple/views/ui/field"
import { HubRequest, type ProviderEnv, type ProviderReturn } from "../provider"
import { ConnectFleet, connectRequestOf, type FleetCardModel, FleetMessage, initFleetForm } from "./fleet"

type Env = ProviderEnv<FleetIntegrationStatus>
type Return = ProviderReturn<FleetCardModel, FleetMessage>

const statusOf = (env: Env): FleetIntegrationStatus | null =>
	Option.getOrNull(AsyncData.getData(env.status.data))

const fieldStep = (
	model: FleetCardModel,
	key: "url" | "token",
	message: Field.Message,
	wrap: (message: Field.Message) => FleetMessage,
): Return => {
	const step = Field.update(model.form[key], message)
	return {
		model: { ...model, form: { ...model.form, [key]: step.model } },
		commands: FoldkitCommand.mapMessages(step.commands ?? [], wrap),
	}
}

const submitted = (model: FleetCardModel, env: Env): Return => {
	const form = model.form
	if (form.isSubmitting || !env.canManage) return { model }
	const status = statusOf(env)
	const mode = status !== null && status.connected ? "replace" : "connect"
	return Option.match(connectRequestOf(form), {
		onNone: () => ({ model }),
		onSome: (request) => ({
			model: { ...model, form: { ...form, isSubmitting: true, error: null } },
			commands: [ConnectFleet({ url: request.url, token: request.token, mode })],
		}),
	})
}

export const update = (model: FleetCardModel, message: FleetMessage, env: Env): Return =>
	FleetMessage.match<Return>(message, {
		GotUrlMessage: ({ message: child }) =>
			fieldStep(model, "url", child, (inner) => FleetMessage.GotUrlMessage({ message: inner })),
		GotTokenMessage: ({ message: child }) =>
			fieldStep(model, "token", child, (inner) => FleetMessage.GotTokenMessage({ message: inner })),
		GotCommandCopyMessage: ({ message: child }) => {
			const step = CopyButton.update(model.commandCopy, child)
			return {
				model: { ...model, commandCopy: step.model },
				commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
					FleetMessage.GotCommandCopyMessage({ message: inner }),
				),
			}
		},
		SubmittedConnect: () => submitted(model, env),
		// The toast, the form cleared and closed, and the status re-read.
		SucceededConnect: ({ title, description }) => ({
			model: { ...model, form: initFleetForm(), isReplacing: false },
			requests: [HubRequest.toast("success", title, description), HubRequest.readStatus("Supersede")],
		}),
		FailedConnect: ({ error }) => ({
			model: { ...model, form: { ...model.form, isSubmitting: false, error } },
		}),
		ClickedReplaceToken: () => ({
			model: { ...model, isReplacing: true, form: initFleetForm(statusOf(env)?.baseUrl ?? "") },
		}),
		ClickedReplaceCancel: () => ({ model: { ...model, isReplacing: false, form: initFleetForm() } }),
	})

/** A rejected token shows the form straight away, with the saved URL already in it. */
export const onStatus = (model: FleetCardModel, env: Env): Return => {
	const status = statusOf(env)
	return status !== null &&
		status.connected &&
		status.authFailed &&
		status.baseUrl !== null &&
		model.form.url.value === "" &&
		!model.form.isSubmitting
		? { model: { ...model, form: { ...model.form, url: Field.init(status.baseUrl) } } }
		: { model }
}
