import type { AiEvaluatorSummary } from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import { Array as Arr, Order } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { skeletonList } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { columnClass } from "@maple/views/ui/column"
import { AppRoute, hrefOf } from "../../../route"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { relativeTime } from "../../kit/relative-time"
import * as Frame from "../../kit/time-frame"
import { th, toolTable, toolTableBody, toolTableHead, toolTableRow } from "../../kit/tools/table"
import { evalsEmptyState, meanScoreLabel, NO_VALUE, passRateLabel, passRateTone } from "../kit/evals"
import { agentSessionsTabs } from "../kit/tabs"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_EVALS_PRESET } from "./update"

type H = HtmlBuilder<Message>

export type EvaluatorsTableInputs = Readonly<{
	rows: ReadonlyArray<AiEvaluatorSummary>
	search: Model["search"]
	nowMs: number
	timeZone: string
	isWaiting: boolean
}>

const NARROW = "hidden @min-[720px]/panel:flex"
const WIDE = "hidden @min-[900px]/panel:flex"

const head = (h: H): Html =>
	toolTableHead(h, [
		th(h, { label: "Evaluator", width: columnClass({ min: "0" }) }),
		th(h, { label: "Scores", width: "w-20 shrink-0", align: "right" }),
		th(h, { label: "Pass rate", width: "w-20 shrink-0", align: "right" }),
		th(h, { label: "Mean score", width: "w-24 shrink-0", align: "right" }),
		th(h, { label: "Eval errors", width: "w-24 shrink-0", align: "right", hidden: NARROW }),
		th(h, { label: "Traces", width: "w-20 shrink-0", align: "right", hidden: NARROW }),
		th(h, { label: "Sources", width: "w-36 shrink-0", hidden: WIDE }),
		th(h, { label: "Last seen", width: "w-24 shrink-0", align: "right", hidden: NARROW }),
		h.span([h.AriaHidden(true), h.Class("w-3.5 shrink-0")], []),
	])

const figure = (h: H, value: string, className: string): Html =>
	typography(h, { size: "xs", mono: true, numeric: true, align: "right", tone: "muted", className }, [
		value,
	])

const cells = (h: H, row: AiEvaluatorSummary, inputs: EvaluatorsTableInputs): ReadonlyArray<Html> => [
	typography(
		h,
		{
			size: "xs",
			mono: true,
			tone: "foreground",
			truncate: true,
			className: "min-w-0 flex-1",
			attributes: [h.Title(row.name)],
		},
		[row.name],
	),
	typography(
		h,
		{
			size: "xs",
			mono: true,
			numeric: true,
			align: "right",
			tone: "foreground",
			className: "w-20 shrink-0",
		},
		[formatNumber(row.scoreCount)],
	),
	typography(
		h,
		{
			size: "xs",
			mono: true,
			numeric: true,
			align: "right",
			tone: passRateTone(row),
			className: "w-20 shrink-0",
		},
		[passRateLabel(row)],
	),
	figure(h, meanScoreLabel(row), "w-24 shrink-0"),
	typography(
		h,
		{
			size: "xs",
			mono: true,
			numeric: true,
			align: "right",
			tone: row.errorCount > 0 ? "warning" : "subtle",
			className: "hidden w-24 shrink-0 @min-[720px]/panel:block",
		},
		[formatNumber(row.errorCount)],
	),
	figure(h, formatNumber(row.traceCount), "hidden w-20 shrink-0 @min-[720px]/panel:block"),
	typography(
		h,
		{
			size: "2xs",
			mono: true,
			tone: "muted",
			truncate: true,
			className: "hidden w-36 shrink-0 @min-[900px]/panel:block",
		},
		[row.sources.length === 0 ? NO_VALUE : Arr.join(row.sources, ", ")],
	),
	relativeTime(h, {
		value: row.lastSeen,
		variant: "orDate",
		nowMs: inputs.nowMs,
		timeZone: inputs.timeZone,
		className:
			"hidden w-24 shrink-0 text-right font-mono text-2xs tabular-nums text-foreground-subtle @min-[720px]/panel:block",
	}),
	hstack(h, { justify: "end", as: "span", className: "w-3.5 shrink-0 text-foreground-subtle" }, [
		icon(h, "ChevronRightIcon", { size: 14, attributes: [h.AriaHidden(true)] }),
	]),
]

const byScoresDesc = Order.flip(Order.mapInput(Order.Number, (row: AiEvaluatorSummary) => row.scoreCount))

/** Every evaluator in the window, most scores first; each row opens its detail page. */
export const evaluatorsTable = (h: H, inputs: EvaluatorsTableInputs): Html =>
	h.section(
		[h.AriaLabel("Evaluators"), h.Class("@container/panel min-w-0 px-6 pt-5 pb-6")],
		[
			hstack(h, { gap: "2.5", align: "baseline", className: "pb-3 font-mono" }, [
				typography(h, { size: "xs", tone: "foreground", weight: "medium" }, ["Evaluators"]),
				typography(h, { size: "2xs", tone: "subtle", numeric: true }, [
					formatNumber(inputs.rows.length),
				]),
			]),
			toolTable(
				h,
				[
					head(h),
					toolTableBody(
						h,
						Arr.map(Arr.sort(inputs.rows, byScoresDesc), (row) =>
							toolTableRow(
								h,
								{
									href: hrefOf(
										AppRoute.AgentSessionEvaluator({
											name: row.name,
											search: {
												startTime: inputs.search.startTime,
												endTime: inputs.search.endTime,
												timePreset: inputs.search.timePreset,
											},
										}),
									),
									attributes: [h.Key(row.name)],
								},
								cells(h, row, inputs),
							),
						),
						{ isWaiting: inputs.isWaiting },
					),
				],
				undefined,
				{ hasShrinkingLanes: true },
			),
		],
	)

const loadingView = (h: H): Html =>
	h.div(
		[h.Class("px-6 pt-5")],
		[skeletonList(h, { rows: 4, rowClassName: "h-[38px]", className: "gap-1.5 py-3" })],
	)

/** The evaluators table, or its loading, error and empty states. */
export const evalsBody = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.matchData(model.evaluators.data, {
		onEmpty: () => loadingView(h),
		onFailure: (failure) =>
			h.div(
				[h.Class("p-4")],
				[
					errorState(h, {
						failure,
						title: "Couldn't load evaluators",
						onRetry: Message.ClickedRetry(),
					}),
				],
			),
		onData: (rows) =>
			rows.length === 0
				? vstack(h, { className: "px-6 py-16" }, [
						evalsEmptyState(h, "No eval scores in this window"),
					])
				: evaluatorsTable(h, {
						rows,
						search: model.search,
						nowMs: model.frame.nowMs,
						timeZone,
						isWaiting: AsyncData.isRefreshing(model.evaluators.data),
					}),
	})

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	dashboardPage(
		h,
		{
			title: "Agent sessions",
			actions: Frame.controls(
				h,
				model.frame,
				{ search: model.search, defaultPreset: DEFAULT_EVALS_PRESET },
				toFrame,
				AsyncData.isFailure(model.evaluators.data),
			),
			tabs: agentSessionsTabs(h, { active: "evals", search: model.search, hasEvals: true }),
			scrollClassName: "p-0",
		},
		[evalsBody(h, model, inputs.context.timeZone)],
	),
)
