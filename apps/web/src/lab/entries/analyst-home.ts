import { Effect, Option, Schema, Array as Arr } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { Message as PageMessage } from "../../page/overview/analyst/message"
import { Model as PageModel } from "../../page/overview/analyst/model"
import { update as pageUpdate } from "../../page/overview/analyst/update"
import { view as pageView } from "../../page/overview/analyst/view"
import { ANALYST_CONTEXT, type AnalystHomeState, analystHomeModel, STATES } from "../analyst-home-fixture"
import { ANALYST_CLERK } from "../shell-frame"
import { defineShellLab } from "../shell-lab"

// `/lab/analyst-home`: the Overview an analyst gets, inside the analyst's shell, with nothing
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
	const next = pageUpdate(model.page, message.message, ANALYST_CONTEXT)
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
		slotId: "analyst-home-lab",
		model: model.page,
		view: pageView,
		viewInputs: { context: ANALYST_CONTEXT },
		toParentMessage: (message) => Message.GotPageMessage({ message }),
	})

export const lab = defineShellLab("Analyst overview", {
	Model,
	Message,
	Flags,
	flags: Effect.sync(() => ({
		state: Option.getOrElse(
			decodeState(new URLSearchParams(window.location.search).get("state")),
			(): AnalystHomeState => "clear",
		),
	})),
	init: (flags: Flags) => ({ model: { page: analystHomeModel(flags.state) } }),
	update,
	view,
	clerk: ANALYST_CLERK,
	currentPath: "/",
	breadcrumbs: [{ label: "Overview" }],
})
