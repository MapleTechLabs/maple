import { OrgId } from "@maple/domain"
import { buildToolAnalyticsFixture, buildToolCells, toolFixtureFacets } from "../agent-tools-fixture"
import { Option, Result, Schema } from "effect"
import { Command, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { fromString } from "foldkit/url"
import { ResolveThemeColors } from "../../charts/theme-colors"
import type { PageContext, PageOutMessage } from "../../page/contract"
import { Selection } from "../../page/agent-sessions/tools-kit/reads"
import { TOOL_CHART_TOKENS } from "../../page/agent-sessions/tools-kit/series-chart"
import { Message as ToolsMessage } from "../../page/agent-sessions/tools/message"
import { Model as ToolsModel } from "../../page/agent-sessions/tools/model"
import {
	init as toolsInit,
	routeChanged,
	update as toolsUpdate,
} from "../../page/agent-sessions/tools/update"
import { toolsBody } from "../../page/agent-sessions/tools/view"
import type { Resources } from "../../platform/resources"
import { urlToAppRoute } from "../../route"
import * as Toast from "../../ui/toast"
import { ViewerFlags, viewerFlags } from "../../ui/logs/viewer"
import { defineLabWithFlags } from "../define"
import { foldLabToasts, initLabToasts, labRoot } from "../toasts"

// `/lab/agent-tools` (apps/web `lab/agent-tools-lab.tsx`): the tools page over apps/web's synthetic
// week. The page's warehouse reads are answered from the fixture; its URL is the lab's state.
// TODO(lab-detail): the "detail" view (tool detail page and error modal over the fixture) is drawn as
// its toggle only.

const WIDTHS = [
	{ label: "Full", value: null },
	{ label: "1400px", value: 1400 },
	{ label: "1100px", value: 1100 },
	{ label: "820px", value: 820 },
] as const
const VIEWS = ["overview", "detail"] as const

const Model = Schema.Struct({
	page: ToolsModel,
	view: Schema.Literals(VIEWS),
	width: Schema.NullOr(Schema.Number),
	timeZone: Schema.String,
	toasts: Toast.Model,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
	GotPageMessage: { message: ToolsMessage },
	ClickedView: { view: Schema.Literals(VIEWS) },
	ClickedWidth: { width: Schema.NullOr(Schema.Number) },
	GotToastMessage: { message: Toast.Message },
})
type Message = typeof Message.Type

type PageCommand = Command.Command<ToolsMessage, never, Resources>
type Return = Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> }>

const contextOf = (timeZone: string): PageContext => ({
	orgId: Schema.decodeSync(OrgId)("org_lab"),
	pinnedNamespace: null,
	timeZone,
})

const ReadArgs = Schema.Struct({
	key: Schema.String,
	selection: Selection,
	isScope: Schema.optionalKey(Schema.Boolean),
	isTab: Schema.optionalKey(Schema.Boolean),
})
const decodeRead = Schema.decodeUnknownOption(ReadArgs)
const FacetArgs = Schema.Struct({ key: Schema.String })
const decodeFacetRead = Schema.decodeUnknownOption(FacetArgs)

/** The fixture's reading of a selection: its search keys, as the lab's local state carries them. */
const fixtureOf = (selection: Selection, nowMs: number) =>
	buildToolAnalyticsFixture(
		{
			q: selection.search,
			service: selection.service,
			env: selection.env,
			failing: selection.failingOnly,
			tool: selection.tool,
			model: selection.model,
		},
		nowMs,
		buildToolCells(nowMs),
	)

/** The fixture's answer to one of the page's reads; `None` for a Command that is not a read. */
const answer = (command: PageCommand, nowMs: number): Option.Option<ToolsMessage> => {
	if (command.name === "FetchAgentToolsFacets") {
		const facets = toolFixtureFacets(buildToolCells(nowMs))
		return Option.map(decodeFacetRead(command.args), ({ key }) =>
			ToolsMessage.CompletedFetchFacets({
				key,
				result: Result.succeed({ vendors: [], agents: [], tools: [], ...facets }),
			}),
		)
	}
	return Option.flatMap(decodeRead(command.args), ({ key, selection, isScope, isTab }) => {
		const data = fixtureOf(selection, nowMs)
		switch (command.name) {
			case "FetchAgentToolsSeries": {
				const series =
					isScope === true
						? { data: data.scopeSeries, seriesKind: "none" as const }
						: { data: data.series, seriesKind: data.seriesKind }
				const result = Result.succeed(series)
				return Option.some(
					isScope === true
						? ToolsMessage.CompletedFetchScopeSeries({ key, result })
						: ToolsMessage.CompletedFetchSeries({ key, result }),
				)
			}
			case "FetchAgentToolsTotals": {
				const result = Result.succeed({
					current: data.totals,
					previous: data.previousTotals,
					allSessions: data.allSessions,
					firstSeen: 0,
					lastSeen: 0,
					description: undefined,
				})
				return Option.some(
					isTab === true
						? ToolsMessage.CompletedFetchTabTotals({ key, result })
						: ToolsMessage.CompletedFetchTotals({ key, result }),
				)
			}
			case "FetchAgentToolsBreakdowns": {
				const result = Result.succeed({ tools: data.tools })
				return Option.some(
					isTab === true
						? ToolsMessage.CompletedFetchTabBreakdowns({ key, result })
						: ToolsMessage.CompletedFetchBreakdowns({ key, result }),
				)
			}
			default:
				return Option.none()
		}
	})
}

/** The page's navigations become the lab's state: the new search re-enters the page as the route would. */
const followNavigation = (model: Model, outMessage: PageOutMessage | undefined) => {
	if (outMessage?._tag !== "RequestedNavigation") return Option.none()
	return Option.flatMap(Option.map(fromString(`http://lab${outMessage.url}`), urlToAppRoute), (route) =>
		route._tag === "AgentSessionTools"
			? Option.some(routeChanged(model.page, { search: route.search }, contextOf(model.timeZone)))
			: Option.none(),
	)
}

type PageStep = Readonly<{
	model: ToolsModel
	commands?: ReadonlyArray<PageCommand>
	outMessage?: PageOutMessage
}>

/** Runs a page step to rest: reads are answered in place, navigations re-enter, the rest is lifted. */
const settle = (model: Model, step: PageStep): Return => {
	const withPage: Model = { ...model, page: step.model }
	const resolved = (step.commands ?? []).map(
		(command) => [command, answer(command, step.model.nowMs)] as const,
	)
	const answers = resolved.flatMap(([, maybe]) => Option.toArray(maybe))
	const rest = resolved.flatMap(([command, maybe]) => (Option.isNone(maybe) ? [command] : []))
	const navigated = Option.match(followNavigation(withPage, step.outMessage), {
		onNone: () => ({ model: withPage, commands: [] }),
		onSome: (next) => settle(withPage, next),
	})
	return answers.reduce<Return>(
		(result, message) => {
			const next = settle(
				result.model,
				toolsUpdate(result.model.page, message, contextOf(result.model.timeZone)),
			)
			return { model: next.model, commands: [...(result.commands ?? []), ...(next.commands ?? [])] }
		},
		{
			model: navigated.model,
			commands: [
				...Command.mapMessages(rest, (message) => Message.GotPageMessage({ message })),
				...(navigated.commands ?? []),
			],
		},
	)
}

const foldToasts = foldLabToasts<Model, Message>((message) => Message.GotToastMessage({ message }))

const init = (flags: ViewerFlags): Return => {
	const entered = toolsInit({ search: {} }, contextOf(flags.timeZone))
	const model: Model = {
		page: entered.model,
		view: "overview",
		width: null,
		timeZone: flags.timeZone,
		toasts: initLabToasts(),
	}
	return settle(model, entered)
}

const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotPageMessage: ({ message: inner }) =>
			settle(model, toolsUpdate(model.page, inner, contextOf(model.timeZone))),
		ClickedView: ({ view }) => ({ model: { ...model, view } }),
		ClickedWidth: ({ width }) => ({ model: { ...model, width } }),
		GotToastMessage: ({ message: inner }) => foldToasts(model, inner),
	})

const toggleClass = (isActive: boolean): string =>
	isActive
		? "rounded border border-border bg-accent px-2 py-1 text-xs"
		: "rounded border border-border px-2 py-1 text-xs text-muted-foreground"

const labButton = (h: HtmlBuilder<Message>, label: string, isActive: boolean, onClick: Message): Html =>
	h.button([h.Class(toggleClass(isActive)), h.Type("button"), h.OnClick(onClick)], [label])

const toolsPage = Submodel.defineView<ToolsModel, ToolsMessage, Readonly<{ timeZone: string }>>(
	(page, inputs, h) =>
		h.div(
			[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: TOOL_CHART_TOKENS }))],
			[toolsBody(h, page, { timeZone: inputs.timeZone, isFilled: false })],
		),
)

/** The search as the lab prints it: the keys set, in the page's order. */
const searchJson = (model: Model): string =>
	JSON.stringify(
		Object.fromEntries(Object.entries(model.page.search).filter(([, value]) => value !== undefined)),
	)

const page = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("flex flex-col gap-4 p-6")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					...VIEWS.map((view) =>
						labButton(h, view, model.view === view, Message.ClickedView({ view })),
					),
					h.span([h.Class("w-4")], []),
					...WIDTHS.map((option) =>
						labButton(
							h,
							option.label,
							model.width === option.value,
							Message.ClickedWidth({ width: option.value }),
						),
					),
					h.span([h.Class("ml-2 font-mono text-2xs text-muted-foreground")], [searchJson(model)]),
				],
			),
			h.div(
				[
					h.Class("@container/page min-w-0 overflow-hidden rounded-lg border border-border"),
					...(model.width === null ? [] : [h.Style({ width: `${model.width}px` })]),
				],
				[
					h.submodel({
						slotId: "lab-agent-tools-page",
						model: model.page,
						view: toolsPage,
						viewInputs: { timeZone: model.timeZone },
						toParentMessage: (message: ToolsMessage) => Message.GotPageMessage({ message }),
					}),
				],
			),
		],
	)

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	labRoot(h, model.toasts, (message) => Message.GotToastMessage({ message }), page(model, h))

export const lab = defineLabWithFlags("Agent tools", {
	Model,
	Flags: ViewerFlags,
	flags: viewerFlags,
	init,
	update,
	view,
})
