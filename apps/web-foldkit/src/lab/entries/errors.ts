import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { Resources } from "../../platform/resources"
import * as Shell from "../../shell"
import { foldLabShell, initLabShell, LabShellFlags, labShellFlags, labShellSubscriptions, labShellView } from "../app-shell"
import { defineLabWithFlags } from "../define"
import * as Page from "../errors-lab/model"
import { ErrorsLabFlags, errorsLabFlags, init as initPage, update as updatePage } from "../errors-lab/update"
import { view as pageView } from "../errors-lab/view"

// `/lab/errors` (apps/web `lab/errors-lab.tsx`): the errors hub over fixtures, inside the real shell.

const Model = Schema.Struct({ page: Page.Model, shell: Shell.Model })
type Model = typeof Model.Type

const Message = defineMessageUnion({
	GotPageMessage: { message: Page.Message },
	GotShellMessage: { message: Shell.Message },
})
type Message = typeof Message.Type

type Return = Update.ReturnWithOutMessage<Model, Message, never, Resources>

const toShell = (message: Shell.Message) => Message.GotShellMessage({ message })
const toPage = (message: Page.Message) => Message.GotPageMessage({ message })

const init = (flags: ErrorsLabFlags & LabShellFlags): Return => {
	const shell = initLabShell(flags)
	return {
		model: { page: initPage(flags), shell: shell.model },
		commands: Command.mapMessages(shell.commands ?? [], toShell),
	}
}

const foldShell = foldLabShell<Model, Message>(toShell)

const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotPageMessage: ({ message: inner }) => {
			const next = updatePage(model.page, inner)
			return { model: { ...model, page: next.model }, commands: Command.mapMessages(next.commands ?? [], toPage) }
		},
		GotShellMessage: ({ message: inner }) => foldShell(model, inner),
	})

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Id("app")],
		labShellView(h, model.shell, toShell, {
			currentPath: "/lab/errors",
			breadcrumbs: [{ label: "Lab" }, { label: "Errors" }],
			page: () =>
				h.submodel({
					slotId: "errors-lab-page",
					model: model.page,
					view: pageView,
					toParentMessage: toPage,
				}),
		}),
	)

export const lab = defineLabWithFlags("Errors", {
	Model,
	Flags: Schema.Struct({ ...ErrorsLabFlags.fields, ...LabShellFlags.fields }),
	flags: Effect.map(Effect.all([errorsLabFlags, labShellFlags]), ([page, shell]) => ({ ...page, ...shell })),
	init,
	update,
	view,
	subscriptions: labShellSubscriptions<Model, Message>(toShell),
})
