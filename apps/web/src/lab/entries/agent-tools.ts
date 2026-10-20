import { OrgId } from "@maple/domain"
import { buildToolAnalyticsFixture, buildToolCells, toolFixtureFacets } from "../agent-tools-fixture"
import { Option, Result, Schema } from "effect"
import { AsyncData, Command, Submodel } from "foldkit"
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
import { Message as ToolMessage } from "../../page/agent-sessions/tool/message"
import { Model as ToolModel } from "../../page/agent-sessions/tool/model"
import { init as toolInit, update as toolUpdate } from "../../page/agent-sessions/tool/update"
import { toolDetailBody } from "../../page/agent-sessions/tool/view"
import { GRID_TOKENS } from "../../page/agent-sessions/tool/view-charts"
import { contextOf as detailContextOf, settle as settleDetail } from "../agent-tools-detail"
import { DETAIL_TOOLS } from "../agent-tools-detail-fixture"
import type { Resources } from "../../platform/resources"
import { urlToAppRoute } from "../../route"
import * as Toast from "../../ui/toast"
import { ViewerFlags, viewerFlags } from "../../ui/logs/viewer"
import { defineLabWithFlags } from "../define"
import { foldLabToasts, initLabToasts, labRoot } from "../toasts"

// `/lab/agent-tools`: the tools page over a synthetic
// week. The page's warehouse reads are answered from the fixture; its URL is the lab's state. The
// "detail" view is the tool detail page and its error modal over the fixture's failure groups.

const WIDTHS = [
	{ label: "Full", value: null },
	{ label: "1400px", value: 1400 },
	{ label: "1100px", value: 1100 },
	{ label: "820px", value: 820 },
] as const
const VIEWS = ["overview", "detail"] as const

const Model = Schema.Struct({
	page: ToolsModel,
	detail: ToolModel,
	detailTool: Schema.Literals(DETAIL_TOOLS),
	/** "errors loading": the Errors table as it draws before its read answers. */
	isErrorsLoading: Schema.Boolean,
	view: Schema.Literals(VIEWS),
	width: Schema.NullOr(Schema.Number),
	timeZone: Schema.String,
	toasts: Toast.Model,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
	GotPageMessage: { message: ToolsMessage },
	GotDetailMessage: { message: ToolMessage },
	ClickedDetailTool: { tool: Schema.Literals(DETAIL_TOOLS) },
	ToggledErrorsLoading: {},
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

/** The detail page entered on `tool`, its reads answered; the lab's Commands carry the rest. */
const enterDetail = (tool: (typeof DETAIL_TOOLS)[number], timeZone: string, previous?: ToolModel) => {
	// The toolbar filters carry over; the theme read stays, since its Mount does not run again.
	const search = { service: previous?.search.service, env: previous?.search.env, model: previous?.search.model }
	const entered = toolInit({ toolName: tool, search }, detailContextOf(timeZone))
	const carried = previous === undefined ? entered : { ...entered, model: { ...entered.model, themeColors: previous.themeColors } }
	const settled = settleDetail(carried, timeZone)
	return {
		detail: settled.model,
		commands: Command.mapMessages(settled.commands, (message) => Message.GotDetailMessage({ message })),
	}
}

const init = (flags: ViewerFlags): Return => {
	const entered = toolsInit({ search: {} }, contextOf(flags.timeZone))
	const detail = enterDetail("submit_candidate", flags.timeZone)
	const settled = settle(
		{
			page: entered.model,
			detail: detail.detail,
			detailTool: "submit_candidate",
			isErrorsLoading: false,
			view: "overview",
			width: null,
			timeZone: flags.timeZone,
			toasts: initLabToasts(),
		},
		entered,
	)
	return { model: settled.model, commands: [...(settled.commands ?? []), ...detail.commands] }
}

const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotPageMessage: ({ message: inner }) =>
			settle(model, toolsUpdate(model.page, inner, contextOf(model.timeZone))),
		GotDetailMessage: ({ message: inner }) => {
			const settled = settleDetail(toolUpdate(model.detail, inner, detailContextOf(model.timeZone)), model.timeZone)
			return {
				model: { ...model, detail: settled.model },
				commands: Command.mapMessages(settled.commands, (message) => Message.GotDetailMessage({ message })),
			}
		},
		// A different tool is a fresh page: its group, session and variant are not carried over.
		ClickedDetailTool: ({ tool }) => {
			const entered = enterDetail(tool, model.timeZone, model.detail)
			return { model: { ...model, detail: entered.detail, detailTool: tool }, commands: entered.commands }
		},
		ToggledErrorsLoading: () => ({ model: { ...model, isErrorsLoading: !model.isErrorsLoading } }),
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
		Object.fromEntries(
			Object.entries(model.view === "detail" ? model.detail.search : model.page.search).filter(
				([key, value]) => value !== undefined && key !== "timePreset",
			),
		),
	)

/** The detail page without the route's time controls, the Errors read held while "errors loading". */
const detailPage = Submodel.defineView<ToolModel, ToolMessage, Readonly<{ timeZone: string; isErrorsLoading: boolean }>>(
	(detail, inputs, h) =>
		h.div(
			[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: GRID_TOKENS }))],
			[
				toolDetailBody(
					h,
					inputs.isErrorsLoading ? { ...detail, errors: { ...detail.errors, data: AsyncData.Loading() } } : detail,
					{ timeZone: inputs.timeZone, isRoute: false },
				),
			],
		),
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
					...(model.view === "detail"
						? [
								h.span([h.Class("w-4")], []),
								...DETAIL_TOOLS.map((tool) =>
									labButton(h, tool, model.detailTool === tool, Message.ClickedDetailTool({ tool })),
								),
								labButton(h, "errors loading", model.isErrorsLoading, Message.ToggledErrorsLoading()),
							]
						: []),
					h.span([h.Class("ml-2 font-mono text-2xs text-muted-foreground")], [searchJson(model)]),
				],
			),
			h.div(
				[
					h.Class("@container/page min-w-0 overflow-hidden rounded-lg border border-border"),
					...(model.width === null ? [] : [h.Style({ width: `${model.width}px` })]),
				],
				[
					model.view === "detail"
						? h.submodel({
								slotId: "lab-agent-tools-detail",
								model: model.detail,
								view: detailPage,
								viewInputs: { timeZone: model.timeZone, isErrorsLoading: model.isErrorsLoading },
								toParentMessage: (message: ToolMessage) => Message.GotDetailMessage({ message }),
							})
						: h.submodel({
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
