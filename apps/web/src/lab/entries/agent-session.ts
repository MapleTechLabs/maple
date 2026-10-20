import {
	buildAgentSessionFixture,
	buildCaptureOffFixture,
	buildCleanFixture,
} from "@maple/agent-sessions/testing"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { Message as SessionMessage } from "../../page/agent-sessions/session/message"
import { Model as SessionModel } from "../../page/agent-sessions/session/model"
import type { Resources } from "../../platform/resources"
import { ViewerFlags, viewerFlags } from "../../ui/logs/viewer"
import * as Toast from "../../ui/toast"
import { toggle } from "../../ui/toggle"
import { defineLabWithFlags } from "../define"
import {
	enterSession,
	type SessionStep,
	sessionTitle,
	sessionViews,
	stepSession,
	toWire,
	withSpans,
} from "../session-lab"
import { foldLabToasts, initLabToasts, labRoot } from "../toasts"

// `/lab/agent-session`: the session page's header and four
// views over the package's fixture, with the Clean and Capture off toggles. No warehouse reads.

const SESSION_ID = "lab-session-0f3c9a1e2b7d"

const Flags = Schema.Struct({ ...ViewerFlags.fields, view: Schema.NullOr(Schema.String) })
type Flags = typeof Flags.Type

const Model = Schema.Struct({
	session: SessionModel,
	isClean: Schema.Boolean,
	isCaptureOff: Schema.Boolean,
	timeZone: Schema.String,
	toasts: Toast.Model,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
	GotSessionMessage: { message: SessionMessage },
	ToggledClean: {},
	ToggledCaptureOff: {},
	GotToastMessage: { message: Toast.Message },
})
type Message = typeof Message.Type

type Return = Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> }>

const toLab = (message: SessionMessage) => Message.GotSessionMessage({ message })

const spansOf = (isClean: boolean, isCaptureOff: boolean) =>
	toWire(
		isClean ? buildCleanFixture() : isCaptureOff ? buildCaptureOffFixture() : buildAgentSessionFixture(),
		SESSION_ID,
	)

const landed = (model: Model, step: SessionStep): Return => ({
	model: { ...model, session: step.session },
	commands: Command.mapMessages(step.commands, toLab),
})

/** A toggle swaps the session's spans; the views keep their state. */
const swapped = (model: Model): Return =>
	landed(model, withSpans(model.session, spansOf(model.isClean, model.isCaptureOff), model.timeZone))

const foldToasts = foldLabToasts<Model, Message>((message) => Message.GotToastMessage({ message }))

const init = (flags: Flags): Return => {
	const entered = enterSession(SESSION_ID, flags.view ?? undefined, spansOf(false, false), flags.timeZone)
	return landed(
		{
			session: entered.session,
			isClean: false,
			isCaptureOff: false,
			timeZone: flags.timeZone,
			toasts: initLabToasts(),
		},
		entered,
	)
}

const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotSessionMessage: ({ message: inner }) =>
			landed(model, stepSession(model.session, inner, model.timeZone)),
		ToggledClean: () => swapped({ ...model, isClean: !model.isClean }),
		ToggledCaptureOff: () => swapped({ ...model, isCaptureOff: !model.isCaptureOff }),
		GotToastMessage: ({ message: inner }) => foldToasts(model, inner),
	})

const labToggle = (h: HtmlBuilder<Message>, label: string, isPressed: boolean, onClick: Message): Html =>
	toggle(h, { variant: "outline", size: "sm", isPressed, onClick, className: "text-xs" }, [label])

const page = (model: Model, h: HtmlBuilder<Message>): Html => {
	const selected = model.session.search.span
	const inputs = { timeZone: model.timeZone }
	return h.div(
		[h.Class("flex h-screen flex-col bg-background")],
		[
			h.div(
				[h.Class("flex shrink-0 items-start gap-4 border-border border-b px-4 py-3")],
				[
					h.div(
						[h.Class("min-w-0 flex-1")],
						[
							h.submodel({
								slotId: "lab-session-header",
								model: model.session,
								view: sessionTitle,
								viewInputs: inputs,
								toParentMessage: toLab,
							}),
							...(selected === undefined
								? []
								: [
										h.p(
											[h.Class("mt-1 text-muted-foreground text-xs")],
											["selected ", selected],
										),
									]),
						],
					),
					h.div(
						[h.Class("ml-auto flex shrink-0 items-center gap-2")],
						[
							labToggle(h, "Clean", model.isClean, Message.ToggledClean()),
							labToggle(h, "Capture off", model.isCaptureOff, Message.ToggledCaptureOff()),
						],
					),
				],
			),
			h.div(
				[
					h.DataAttribute("slot", "page-scroll-area"),
					h.Class("flex min-h-0 flex-1 flex-col overflow-auto px-4"),
				],
				[
					h.submodel({
						slotId: "lab-session-views",
						model: model.session,
						view: sessionViews,
						viewInputs: inputs,
						toParentMessage: toLab,
					}),
				],
			),
		],
	)
}

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	labRoot(h, model.toasts, (message) => Message.GotToastMessage({ message }), page(model, h))

export const lab = defineLabWithFlags("Agent session", {
	Model,
	Flags,
	flags: Effect.map(viewerFlags, (viewer) => ({
		...viewer,
		view: new URLSearchParams(window.location.search).get("view"),
	})),
	init,
	update,
	view,
})
