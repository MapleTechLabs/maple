import { OrgId } from "@maple/domain"
import { AiEvaluationScore } from "@maple/domain/http"
import { Effect, Option, Schema } from "effect"
import { AsyncData, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { PageContext } from "../page/contract"
import { dashboardPage } from "../page/kit/dashboard-page"
import * as Frame from "../page/kit/time-frame"
import { Message as EvalsMessage } from "../page/agent-sessions/evals/message"
import { Model as EvalsModel } from "../page/agent-sessions/evals/model"
import { update as evalsUpdate } from "../page/agent-sessions/evals/update"
import { view as evalsView } from "../page/agent-sessions/evals/view"
import { Message as EvaluatorMessage } from "../page/agent-sessions/evaluator/message"
import { type EvaluatorDetail, Model as EvaluatorModel } from "../page/agent-sessions/evaluator/model"
import { update as evaluatorUpdate } from "../page/agent-sessions/evaluator/update"
import { view as evaluatorView } from "../page/agent-sessions/evaluator/view"
import { Message as SessionMessage } from "../page/agent-sessions/session/message"
import { sessionScores } from "../page/agent-sessions/session/view-checks"
import type { Resources } from "../platform/resources"
import {
	EVALS_NOW_MS,
	EVALS_WINDOW,
	EVALUATORS,
	FAITHFULNESS_DETAIL,
	FAITHFULNESS_FAILING,
	SESSION_SCORES,
} from "./agent-evals-fixture"

// `/lab/agent-evals`: the Evals tab, an evaluator's page and a session's Scores group over the
// fixture (`?view=list|empty|detail|failing|session`). Reads are answered up front; the
// evaluator's "Failing only" switch flips between the two detail views.

export const LabView = Schema.Literals(["list", "empty", "detail", "failing", "session"])
export type LabView = typeof LabView.Type

export const Flags = Schema.Struct({ view: LabView })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	view: Option.getOrElse(
		Schema.decodeUnknownOption(LabView)(new URLSearchParams(window.location.search).get("view")),
		(): LabView => "list",
	),
}))

export const Model = Schema.Struct({
	view: LabView,
	list: EvalsModel,
	detail: EvaluatorModel,
	scores: Schema.Array(AiEvaluationScore),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotListMessage: { message: EvalsMessage },
	GotDetailMessage: { message: EvaluatorMessage },
	GotSessionMessage: { message: SessionMessage },
})
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab"),
	pinnedNamespace: null,
	timeZone: "UTC",
	hasLlmEvals: true,
}

const frame = (id: string): Frame.Model => ({ ...Frame.init(id), window: EVALS_WINDOW, nowMs: EVALS_NOW_MS })

const loaded = <A>(data: A) => ({ key: "lab", data: AsyncData.Success({ data }) })

const listOf = (view: LabView): EvalsModel => ({
	search: {},
	frame: frame("lab-evals-time-range"),
	evaluators: loaded(view === "empty" ? [] : EVALUATORS),
})

const detailOf = (isFailing: boolean): EvaluatorModel => ({
	name: "faithfulness",
	search: isFailing ? { failing: true } : {},
	frame: frame("lab-evaluator-time-range"),
	detail: loaded<EvaluatorDetail>(isFailing ? FAITHFULNESS_FAILING : FAITHFULNESS_DETAIL),
})

export const init = (flags: Flags): Return => ({
	model: {
		view: flags.view,
		list: listOf(flags.view),
		detail: detailOf(flags.view === "failing"),
		scores: SESSION_SCORES,
	},
})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotListMessage: ({ message: inner }) => ({
			model: { ...model, list: evalsUpdate(model.list, inner, CONTEXT).model },
		}),
		GotDetailMessage: ({ message: inner }) => {
			if (inner._tag !== "ToggledFailingOnly")
				return { model: { ...model, detail: evaluatorUpdate(model.detail, inner, CONTEXT).model } }
			const isFailing = model.view !== "failing"
			return {
				model: { ...model, view: isFailing ? "failing" : "detail", detail: detailOf(isFailing) },
			}
		},
		GotSessionMessage: () => ({ model }),
	})

export const breadcrumbs = (model: Model) =>
	model.view === "detail" || model.view === "failing"
		? [
				{ label: "Lab", href: "/lab" },
				{ label: "Evals", href: "/lab/agent-evals" },
				{ label: model.detail.name },
			]
		: [{ label: "Lab", href: "/lab" }, { label: "Evals" }]

const scoresPanel = Submodel.defineView<ReadonlyArray<AiEvaluationScore>, SessionMessage, Readonly<{}>>(
	(scores, _inputs, h) =>
		dashboardPage(h, { title: "Session scores" }, [
			h.div([h.Class("max-w-3xl")], sessionScores(h, scores, undefined)),
		]),
)

export const view = (model: Model, h: HtmlBuilder<Message>): Html => {
	switch (model.view) {
		case "list":
		case "empty":
			return h.submodel({
				slotId: "lab-agent-evals-list",
				model: model.list,
				view: evalsView,
				viewInputs: { context: CONTEXT },
				toParentMessage: (message: EvalsMessage) => Message.GotListMessage({ message }),
			})
		case "detail":
		case "failing":
			return h.submodel({
				slotId: "lab-agent-evals-detail",
				model: model.detail,
				view: evaluatorView,
				viewInputs: { context: CONTEXT },
				toParentMessage: (message: EvaluatorMessage) => Message.GotDetailMessage({ message }),
			})
		case "session":
			return h.submodel({
				slotId: "lab-agent-evals-session",
				model: model.scores,
				view: scoresPanel,
				viewInputs: {},
				toParentMessage: (message: SessionMessage) => Message.GotSessionMessage({ message }),
			})
	}
}
