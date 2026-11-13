import { Effect, Option, Schema, Array as Arr } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { Message as PageMessage } from "../../page/overview/observer/message"
import { Model as PageModel } from "../../page/overview/observer/model"
import { update as pageUpdate } from "../../page/overview/observer/update"
import { view as pageView } from "../../page/overview/observer/view"
import { OBSERVER_CONTEXT, type ObserverHomeState, observerHomeModel, STATES } from "../observer-home-fixture"
import { OBSERVER_CLERK } from "../shell-frame"
import { defineShellLab } from "../shell-lab"

// `/lab/observer-home`: the Overview an observer gets, inside the observer's shell, with nothing
// wrong, with incidents and failing checks, with nothing set up, loading and with one read failing
// (`?state=clear|attention|empty|loading|failed`).

const Model = Schema.Struct({ page: PageModel })
type Model = typeof Model.Type

const Message = defineMessageUnion({ GotPageMessage: { message: PageMessage } })
type Message = typeof Message.Type

const Flags = Schema.Struct({ state: Schema.Literals(STATES) })
type Flags = typeof Flags.Type

const decodeState = Schema.decodeUnknownOption(Schema.Literals(STATES))

// Reads that would reach the API or move the fixtures' fixed clock; the lab has neither.
const REMOTE = /^(Fetch|Load|Read|Resolve)/

const update = (model: Model, message: Message) => {
	const next = pageUpdate(model.page, message.message, OBSERVER_CONTEXT)
	return {
		model: { page: next.model },
		commands: Command.mapMessages(
			Arr.filter(next.commands ?? [], (command) => !REMOTE.test(command.name)),
			(inner) => Message.GotPageMessage({ message: inner }),
		),
	}
}

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "observer-home-lab",
		model: model.page,
		view: pageView,
		viewInputs: { context: OBSERVER_CONTEXT },
		toParentMessage: (message) => Message.GotPageMessage({ message }),
	})

export const lab = defineShellLab("Observer overview", {
	Model,
	Message,
	Flags,
	flags: Effect.sync(() => ({
		state: Option.getOrElse(
			decodeState(new URLSearchParams(window.location.search).get("state")),
			(): ObserverHomeState => "clear",
		),
	})),
	init: (flags: Flags) => ({ model: { page: observerHomeModel(flags.state) } }),
	update,
	view,
	clerk: OBSERVER_CLERK,
	currentPath: "/",
	breadcrumbs: [{ label: "Overview" }],
})
