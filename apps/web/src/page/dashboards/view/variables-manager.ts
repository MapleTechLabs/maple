import { Command } from "foldkit"
import * as VariablesManager from "../kit/variables-manager/update"
import type * as ManagerModel from "../kit/variables-manager/model"
import type { PageContext, PageReturn } from "../../contract"
import { SaveVariables } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

// The toolbar's `VariablesManagerDialog`: opened on the saved variables, saved as one write.

type Return = PageReturn<Model, Message>

const wrap = (message: ManagerModel.Message) => Message.GotVariablesManagerMessage({ message })

export const openVariablesManager = (model: Model): Return => {
	const opened = VariablesManager.open(model.variablesManager, model.document?.variables ?? [])
	return {
		model: { ...model, variablesManager: opened.model },
		commands: Command.mapMessages(opened.commands ?? [], wrap),
	}
}

export const managerStep = (model: Model, context: PageContext, message: ManagerModel.Message): Return => {
	const next = VariablesManager.update(model.variablesManager, message)
	const commands = Command.mapMessages(next.commands ?? [], wrap)
	const updated = { ...model, variablesManager: next.model }
	// Not gated on `persistenceError`: the dialog closed on Save, and a success clears the banner.
	return next.outMessage === undefined
		? { model: updated, commands }
		: {
				model: updated,
				commands: [
					...commands,
					SaveVariables({
						orgId: context.orgId,
						dashboardId: model.dashboardId,
						variables: next.outMessage.variables,
					}),
				],
			}
}
