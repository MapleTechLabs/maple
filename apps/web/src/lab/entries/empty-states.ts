import { OrgId } from "@maple/domain"
import { Clock, Effect, Result, Schema } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as AgentSession from "../../page/agent-sessions/session/model"
import * as AgentSessionMessage from "../../page/agent-sessions/session/message"
import { dividerBlock } from "../../page/agent-sessions/session/transcript-lanes"
import { init as initSession } from "../../page/agent-sessions/session/update"
import { loadIndicator } from "../../page/agent-sessions/session/view-load"
import * as AnomaliesMessage from "../../page/anomalies/list/message"
import * as Anomalies from "../../page/anomalies/list/model"
import { init as initAnomalies, update as updateAnomalies } from "../../page/anomalies/list/update"
import { view as anomaliesView } from "../../page/anomalies/list/view"
import { notFoundContent } from "../../page/chrome"
import type { PageContext } from "../../page/contract"
import * as ErrorsMessage from "../../page/errors/hub/message"
import * as Errors from "../../page/errors/hub/model"
import { init as initErrors } from "../../page/errors/hub/update"
import { hubEmpty } from "../../page/errors/hub/view-empty"
import { pagingFooter } from "../../page/errors/hub/view-list"
import { SignalPresenceData } from "../../page/kit/signal-presence"
import { init as initRecommendations } from "../../page/recommendations/update"
import { view as recommendationsView } from "../../page/recommendations/view"
import * as ReleasesMessage from "../../page/releases/list/message"
import * as Releases from "../../page/releases/list/model"
import { init as initReleases, update as updateReleases } from "../../page/releases/list/update"
import { view as releasesView } from "../../page/releases/list/view"
import { AppRoute } from "../../route"
import { defineLabWithFlags } from "../define"

// `/lab/empty-states?item=<item>`: one empty, load-more or inline-failure state per item, from
// static fixtures, so before and after can be captured from the same page.

export const ITEMS = [
	"errors-filtered",
	"errors-quiet",
	"errors-load-more",
	"errors-load-more-failed",
	"releases-first-run",
	"releases-quiet",
	"releases-filtered",
	"anomalies-first-run",
	"anomalies-loading",
	"session-rest-failed",
	"recommendations-loading",
	"not-found",
] as const

const Item = Schema.Literals(ITEMS)
type Item = typeof Item.Type
const isItem = Schema.is(Item)

const Model = Schema.Struct({ item: Item, nowMs: Schema.Number })
type Model = typeof Model.Type

const Message = defineMessageUnion({ Ignored: {} })
type Message = typeof Message.Type

const Flags = Model
const flags = Effect.all({
	nowMs: Clock.currentTimeMillis,
	item: Effect.sync(() => {
		const item = new URLSearchParams(window.location.search).get("item")
		return isItem(item) ? item : "errors-filtered"
	}),
})

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_empty_states"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const ignore = () => Message.Ignored()

type Presence = "present" | "absent"
const presenceOf = (status: Presence): SignalPresenceData =>
	AsyncData.settle(SignalPresenceData.Loading(), Result.succeed({ traces: { status, lastSeenMs: null } }))

const errorsModel = (nowMs: number, presence: Presence): Errors.Model => ({
	...initErrors({ search: {} }, context).model,
	nowMs,
	presence: presenceOf(presence),
})

const errorsEmptyView = Submodel.defineView<Errors.Model, ErrorsMessage.Message, { isNarrowed: boolean }>(
	(model, inputs, h) => hubEmpty(h, model, inputs.isNarrowed),
)
const errorsFooterView = Submodel.defineView<Errors.Model, ErrorsMessage.Message, { paging: "more" | "failed" }>(
	(_model, inputs, h) => h.div([], pagingFooter(h, inputs.paging)),
)

const WINDOW = { startTime: "2026-11-01 00:00:00", endTime: "2026-11-01 06:00:00" }

const releasesModel = (nowMs: number, presence: Presence, search: Releases.Model["search"]): Releases.Model => {
	const entered = initReleases({ search }, context).model
	const resolved = updateReleases(
		entered,
		ReleasesMessage.Message.CompletedResolveWindow({ window: WINDOW, nowMs, mode: "Load" }),
		context,
	).model
	const loaded = updateReleases(
		resolved,
		ReleasesMessage.Message.CompletedFetchReleases({
			key: resolved.releases.key ?? "",
			result: Result.succeed({
				releases: [],
				timeline: [],
				truncated: false,
				startTime: WINDOW.startTime,
				endTime: WINDOW.endTime,
				bucketSeconds: 3600,
			}),
		}),
		context,
	).model
	return { ...loaded, presence: presenceOf(presence) }
}

const anomaliesModel = (nowMs: number, presence: Presence | null): Anomalies.Model => {
	const entered = initAnomalies({ search: {} }, context).model
	if (presence === null) return entered
	const loaded = [
		AnomaliesMessage.Message.ReadClock({ nowMs }),
		AnomaliesMessage.Message.CompletedFetchFirstPage({
			key: entered.firstPage.key ?? "",
			result: Result.succeed({ data: [], nextCursor: null }),
		}),
	].reduce((model, message) => updateAnomalies(model, message, context).model, entered)
	return { ...loaded, presence: presenceOf(presence) }
}

const FAILED_PROGRESS = { phase: "failed", agentSpansComplete: false, loadedSpans: 1200, loadedAgentSpans: 340 } as const

const sessionView = Submodel.defineView<AgentSession.Model, AgentSessionMessage.Message>((model, h) =>
	h.div(
		[h.Class("flex flex-col gap-10")],
		[
			h.div([h.Class("flex justify-end border-b pb-4")], [loadIndicator(h, model, FAILED_PROGRESS)]),
			dividerBlock(h, { kind: "divider", key: "divider:more", depth: 0, dividerKind: "more", startMs: undefined }, FAILED_PROGRESS, "UTC"),
		],
	),
)

const itemView = (model: Model, h: HtmlBuilder<Message>): Html => {
	const { nowMs } = model
	switch (model.item) {
		case "errors-filtered":
		case "errors-quiet":
			return h.submodel({
				slotId: "lab-errors-empty",
				model: errorsModel(nowMs, "present"),
				view: errorsEmptyView,
				toParentMessage: ignore,
				viewInputs: { isNarrowed: model.item === "errors-filtered" },
			})
		case "errors-load-more":
		case "errors-load-more-failed":
			return h.submodel({
				slotId: "lab-errors-footer",
				model: errorsModel(nowMs, "present"),
				view: errorsFooterView,
				toParentMessage: ignore,
				viewInputs: { paging: model.item === "errors-load-more" ? "more" : "failed" },
			})
		case "releases-first-run":
		case "releases-quiet":
		case "releases-filtered":
			return h.submodel({
				slotId: "lab-releases",
				model: releasesModel(
					nowMs,
					model.item === "releases-first-run" ? "absent" : "present",
					model.item === "releases-filtered" ? { environments: ["staging"] } : {},
				),
				view: releasesView,
				toParentMessage: ignore,
				viewInputs: { context },
			})
		case "anomalies-first-run":
		case "anomalies-loading":
			return h.submodel({
				slotId: "lab-anomalies",
				model: anomaliesModel(nowMs, model.item === "anomalies-first-run" ? "absent" : null),
				view: anomaliesView,
				toParentMessage: ignore,
				viewInputs: { context },
			})
		case "session-rest-failed":
			return h.submodel({
				slotId: "lab-session",
				model: initSession({ sessionId: "lab-session", search: {} }, context).model,
				view: sessionView,
				toParentMessage: ignore,
			})
		case "recommendations-loading":
			return h.submodel({
				slotId: "lab-recommendations",
				model: initRecommendations(AppRoute.Recommendation({ recommendationKey: "lab" }), context).model,
				view: recommendationsView,
				toParentMessage: ignore,
				viewInputs: { context },
			})
		case "not-found":
			return notFoundContent(h)
	}
}

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div([h.Class("mx-auto w-full max-w-5xl p-6")], [h.div([h.Id("lab-item")], [itemView(model, h)])])

export const lab = defineLabWithFlags("Empty states", {
	Model,
	Flags,
	flags,
	init: (input: Model) => ({ model: input }),
	update: (model: Model, _message: Message) => ({ model }),
	view,
})
