import { buildSessionSummary, buildSessionTurns } from "@maple/agent-sessions"
import { Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import { installTranscriptBench } from "../../bench/transcript-harness"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { Message as SessionMessage } from "../../../page/agent-sessions/session/message"
import { Model as SessionModel } from "../../../page/agent-sessions/session/model"
import type { Resources } from "../../../platform/resources"
import { ViewerFlags, viewerFlags } from "../../../ui/logs/viewer"
import * as Toast from "../../../ui/toast"
import { buildLargeSessionFixture } from "../../agent-transcript-fixture"
import { defineLabWithFlags } from "../../define"
import { enterSession, type SessionStep, sessionViews, stepSession, toWire } from "../../session-lab"
import { foldLabToasts, initLabToasts, labRoot } from "../../toasts"

// `/lab/bench/agent-transcript`: the transcript
// over a session big enough to hurt, `?turns=` turns of it, with the perf spec's harness.

const SESSION_ID = "transcript-bench"
const DEFAULT_TURNS = 40

const Flags = Schema.Struct({ ...ViewerFlags.fields, turns: Schema.Number })
type Flags = typeof Flags.Type

const Model = Schema.Struct({
	session: SessionModel,
	turns: Schema.Number,
	spanCount: Schema.Number,
	megabytes: Schema.String,
	timeZone: Schema.String,
	toasts: Toast.Model,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
	GotSessionMessage: { message: SessionMessage },
	GotToastMessage: { message: Toast.Message },
	CompletedBenchInstall: {},
})
type Message = typeof Message.Type

/** `window.__transcriptBench` for the perf spec, for as long as the bench is on the page. */
const InstallTranscriptBench = Mount.define("InstallTranscriptBench", {
	messages: [Message.CompletedBenchInstall],
	execute: () =>
		Effect.acquireRelease(Effect.sync(installTranscriptBench), (uninstall) => Effect.sync(uninstall)).pipe(
			Effect.as(Message.CompletedBenchInstall()),
		),
})

type Return = Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> }>

const toLab = (message: SessionMessage) => Message.GotSessionMessage({ message })

const landed = (model: Model, step: SessionStep): Return => ({
	model: { ...model, session: step.session },
	commands: Command.mapMessages(step.commands, toLab),
})

const foldToasts = foldLabToasts<Model, Message>((message) => Message.GotToastMessage({ message }))

/** `?turns=`: a positive integer, else the default size. */
const turnsOf = (raw: string | null): number => {
	const turns = Number(raw ?? Number.NaN)
	return Number.isInteger(turns) && turns > 0 ? turns : DEFAULT_TURNS
}

const init = (flags: Flags): Return => {
	const spans = buildLargeSessionFixture(flags.turns)
	const summary = buildSessionSummary({ spans, turns: buildSessionTurns(spans) })
	const entered = enterSession(SESSION_ID, "transcript", toWire(spans, SESSION_ID), flags.timeZone)
	return landed(
		{
			session: entered.session,
			turns: flags.turns,
			spanCount: summary.spanCount,
			megabytes: (JSON.stringify(spans).length / 1_048_576).toFixed(1),
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
		GotToastMessage: ({ message: inner }) => foldToasts(model, inner),
		CompletedBenchInstall: () => ({ model }),
	})

const page = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[
			h.DataAttribute("transcript-bench", ""),
			h.Class("flex h-screen flex-col bg-background text-foreground"),
			h.OnMount(InstallTranscriptBench()),
		],
		[
			h.div(
				[h.Class("flex shrink-0 items-center gap-3 border-border border-b px-4 py-2 text-xs")],
				[
					h.span([h.Class("font-semibold")], ["Transcript bench"]),
					h.span(
						[h.Class("text-muted-foreground")],
						[
							String(model.turns),
							" turns · ",
							String(model.spanCount),
							" spans ·",
							" ",
							model.megabytes,
							" MB of spans",
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
						slotId: "lab-transcript-bench",
						model: model.session,
						view: sessionViews,
						viewInputs: { timeZone: model.timeZone },
						toParentMessage: toLab,
					}),
				],
			),
		],
	)

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	labRoot(h, model.toasts, (message) => Message.GotToastMessage({ message }), page(model, h))

export const lab = defineLabWithFlags("Agent transcript bench", {
	Model,
	Flags,
	flags: Effect.map(viewerFlags, (viewer) => ({
		...viewer,
		turns: turnsOf(new URLSearchParams(window.location.search).get("turns")),
	})),
	init,
	update,
	view,
})
