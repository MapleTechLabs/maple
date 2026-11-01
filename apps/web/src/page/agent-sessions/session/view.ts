import { breadcrumbSessionId, buildBackToSessionsHref, resolveWindow } from "@maple/agent-sessions"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../../data/load-failure"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import * as Tabs from "../../../ui/tabs"
import * as TabsView from "../../../ui/tabs-view"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { detailTitleSkeleton } from "../../kit/detail-header"
import { resourceNotFound } from "../../kit/resource-not-found"
import { SESSION_TOO_LARGE_TAG } from "./command"
import { type SessionData, sessionData, viewOf } from "./derive"
import { Message } from "./message"
import type { Model, SessionView } from "./model"
import { sessionHeader } from "./view-header"
import { loadIndicator } from "./view-load"
import { overview } from "./view-overview"
import { controlBar } from "./view-toolbar"
import { transcript } from "./view-transcript"
import { waterfall } from "./view-waterfall"
import { flow } from "./view-flow"
import { viewPopover } from "./span-popover"

// The agent session detail page over `ResultPage`, and its views.

type H = HtmlBuilder<Message>

const TAB_LABELS = ["Overview", "Traces", "Flow", "Transcript"]
const TAB_ICONS = {
	overview: "GridIcon",
	trace: "ChartBarHorizontalIcon",
	flow: "NetworkNodesIcon",
	transcript: "TranscriptIcon",
} as const

const isTabIcon = (value: string): value is keyof typeof TAB_ICONS => value in TAB_ICONS

/** One page of spans holds nothing: the session is not there. */
const isEmpty = (model: Model): boolean =>
	Option.match(AsyncData.getData(model.firstPage.data), {
		onNone: () => false,
		onSome: (page) => page.data.length === 0,
	})

const panel = (
	h: H,
	model: Model,
	data: SessionData,
	view: SessionView,
	timeZone: string,
): ReadonlyArray<Html> => {
	switch (view) {
		case "overview":
			return [overview(h, model, data), viewPopover(h, model, data, view, timeZone)]
		case "trace":
			return [waterfall(h, model, data), viewPopover(h, model, data, view, timeZone)]
		case "flow":
			return [flow(h, model, data), viewPopover(h, model, data, view, timeZone)]
		case "transcript":
			return [transcript(h, model, data, timeZone)]
	}
}

/** `SessionViews` in its page wrapper; the lab draws it outside the page frame. */
export const views = (h: H, model: Model, data: SessionData, timeZone: string): Html => {
	const view = viewOf(model.search.view)
	return h.div(
		[h.Class("flex min-h-64 shrink-0 grow flex-col")],
		[
			h.submodel({
				slotId: "agent-session-views",
				model: model.tabs,
				view: TabsView.view,
				toParentMessage: (message: Tabs.Message) => Message.GotTabsMessage({ message }),
				viewInputs: {
					variant: "underline",
					labels: TAB_LABELS,
					className: "flex grow flex-col gap-0",
					listClassName: "shrink-0",
					panelClassName:
						view === "flow"
							? "flex flex-[1_1_auto] flex-col"
							: "flex flex-[1_1_auto] flex-col pb-4",
					tabContent: (value: string, label: string) => [
						icon(h, isTabIcon(value) ? TAB_ICONS[value] : "GridIcon", { size: 14 }),
						label,
					],
					wrapList: (list: Html) => controlBar(h, model, view, list),
					hasPanel: (value: string) => value === view,
					panel: (value: string) =>
						value === view ? panel(h, model, data, view, timeZone) : undefined,
				},
			}),
		],
	)
}

const loadingBody = (h: H): Html =>
	h.div(
		[h.Class("space-y-6 p-4")],
		[
			skeleton(h, "h-8 w-72"),
			h.div(
				[h.Class("flex flex-wrap items-start justify-between gap-8")],
				[
					h.div(
						[h.Class("space-y-3")],
						[skeleton(h, "h-9 w-[26rem] max-w-full"), skeleton(h, "h-4 w-80 max-w-full")],
					),
					h.div(
						[h.Class("flex gap-6")],
						Array.from({ length: 3 }, () => skeleton(h, "h-16 w-32")),
					),
				],
			),
			skeleton(h, "h-4 w-full rounded-sm"),
			skeletonList(h, { rows: 8, rowClassName: "h-12", gap: "2" }),
		],
	)

const failureBody = (h: H, failure: LoadFailure): Html =>
	errorState(h, {
		failure,
		title: failure._tag === SESSION_TOO_LARGE_TAG ? undefined : "Couldn't load this agent session",
	})

const notFoundBody = (h: H, model: Model): Html => {
	const isWindowed = resolveWindow(model.search.t, model.search.end) !== undefined
	return resourceNotFound(h, {
		icon: icon(h, "SquareSparkleIcon"),
		title: "No spans for this session",
		description: [
			"Nothing was found for ",
			h.span([h.Class("font-mono")], [model.sessionId]),
			isWindowed
				? " around the time this link points at. Open it from the agent sessions list to search again."
				: " in any retained trace. The session may be older than the trace retention.",
		],
		back: { href: "/agent-sessions", label: "Back to agent sessions" },
	})
}

const loadedPage = (h: H, model: Model, inputs: PageViewInputs): Html => {
	const data = sessionData(model)
	const { progress } = data
	return dashboardPage(
		h,
		{
			titleContent: sessionHeader(h, model, data.summary, inputs.context.timeZone),
			actions:
				progress !== undefined && progress.phase !== "complete"
					? loadIndicator(h, model, progress)
					: undefined,
			scrollClassName: "overflow-x-hidden py-0 pr-6",
		},
		[views(h, model, data, inputs.context.timeZone)],
	)
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	isEmpty(model)
		? dashboardPage(h, {}, [notFoundBody(h, model)])
		: AsyncData.matchData(model.firstPage.data, {
				onEmpty: () =>
					dashboardPage(h, { titleContent: detailTitleSkeleton(h), fill: true }, [loadingBody(h)]),
				onFailure: (failure) => dashboardPage(h, {}, [failureBody(h, failure)]),
				onData: () => loadedPage(h, model, inputs),
			}),
)

/** The trail: back to the list the reader came from, then the session id or the state. */
export const breadcrumbsOf = (model: Model) => {
	const last = AsyncData.matchData(model.firstPage.data, {
		onEmpty: () => "Loading…",
		onFailure: () => "Error",
		onData: (page) => (page.data.length === 0 ? "Not found" : breadcrumbSessionId(model.sessionId)),
	})
	return [{ label: "Agent sessions", href: buildBackToSessionsHref(model.searchStr) }, { label: last }]
}
