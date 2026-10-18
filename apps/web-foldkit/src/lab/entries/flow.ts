import { Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { Resources } from "../../platform/resources"
import * as TraceFlow from "../../service-map/trace-flow/trace-flow"
import * as Shell from "../../shell"
import { foldLabShell, initLabShell, LabShellFlags, labShellFlags, labShellSubscriptions, labShellView } from "../app-shell"
import { defineLabWithFlags } from "../define"
import { FLOW_LAB_GRAPH, pageBody } from "../flow-lab"

// `/lab/flow` (apps/web `lab/flow-lab.tsx`): the flow view lab inside the real shell.

export const Model = Schema.Struct({ flow: TraceFlow.Model, shell: Shell.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotFlowMessage: { message: TraceFlow.Message },
	GotShellMessage: { message: Shell.Message },
})
export type Message = typeof Message.Type

type Return = Update.ReturnWithOutMessage<Model, Message, never, Resources>

const toShell = (message: Shell.Message) => Message.GotShellMessage({ message })
const toFlow = (message: TraceFlow.Message) => Message.GotFlowMessage({ message })

const init = (flags: LabShellFlags): Return => {
	const shell = initLabShell(flags)
	return {
		model: { flow: TraceFlow.init(), shell: shell.model },
		commands: Command.mapMessages(shell.commands ?? [], toShell),
	}
}

const updateFlow = TraceFlow.update(FLOW_LAB_GRAPH)
const foldShell = foldLabShell<Model, Message>(toShell)

const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotFlowMessage: ({ message: inner }) => ({ model: { ...model, flow: updateFlow(model.flow, inner) } }),
		GotShellMessage: ({ message: inner }) => foldShell(model, inner),
	})

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Id("app")],
		labShellView(h, model.shell, toShell, {
			currentPath: "/lab/flow",
			breadcrumbs: [{ label: "Flow Lab" }],
			page: () => pageBody(h, model.flow, toFlow),
		}),
	)

export const lab = defineLabWithFlags("Trace flow", {
	Model,
	Flags: LabShellFlags,
	flags: labShellFlags,
	init,
	update,
	view,
	subscriptions: labShellSubscriptions<Model, Message>(toShell),
})
