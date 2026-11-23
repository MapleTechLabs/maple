import type { AiEvaluationBreakdownRow, AiEvaluationScore, AiEvaluatorSummary } from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import { Array as Arr, Order, String as Str } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "@maple/views/ui/error-state"
import { miniBars } from "@maple/views/ui/mini-bars"
import { skeletonList } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statFigure } from "@maple/views/ui/stat-figure"
import { statusDot } from "@maple/views/ui/status-dot"
import { textLink } from "@maple/views/ui/text-link"
import { timestamp } from "@maple/views/ui/timestamp"
import { typography } from "@maple/views/ui/typography"
import { columnClass } from "@maple/views/ui/column"
import { AppRoute, hrefOf } from "../../../route"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import * as Frame from "../../kit/time-frame"
import { th, toolTable, toolTableBody, toolTableHead, toolTableRow } from "../../kit/tools/table"
import { toolFilterToolbar } from "../../kit/tools/toolbar"
import {
	evalsEmptyState,
	meanScoreLabel,
	NO_VALUE,
	passRateLabel,
	passRateOf,
	passRateTone,
	scoreText,
	verdictTone,
} from "../kit/evals"
import { DEFAULT_EVALS_PRESET } from "../evals/update"
import { Message } from "./message"
import type { EvaluatorDetail, Model } from "./model"

type H = HtmlBuilder<Message>

const section = (h: H, label: string, count: number | undefined, children: ReadonlyArray<Html>): Html =>
	h.section(
		[h.AriaLabel(label), h.Class("@container/panel min-w-0 px-6 pt-5")],
		[
			hstack(h, { gap: "2.5", align: "baseline", className: "pb-3 font-mono" }, [
				typography(h, { size: "xs", tone: "foreground", weight: "medium" }, [label]),
				...(count === undefined
					? []
					: [typography(h, { size: "2xs", tone: "subtle", numeric: true }, [formatNumber(count)])]),
			]),
			...children,
		],
	)

const summaryRow = (h: H, summary: AiEvaluatorSummary): Html =>
	hstack(h, { gap: "8", wrap: true, className: "px-6 pt-5" }, [
		statFigure(h, { label: "Scores", value: formatNumber(summary.scoreCount) }),
		statFigure(h, { label: "Pass rate", value: passRateLabel(summary) }),
		statFigure(h, { label: "Mean score", value: meanScoreLabel(summary) }),
		statFigure(h, { label: "Eval errors", value: formatNumber(summary.errorCount) }),
		statFigure(h, { label: "Traces", value: formatNumber(summary.traceCount) }),
	])

/** Each bucket's pass rate as a bar on a 0-100% scale, oldest first; a bucket where nothing passed
 *  (or with no verdicts) keeps a baseline, so an all-failing stretch still shows. */
const passRateBars = (h: H, detail: EvaluatorDetail): Html =>
	section(h, "Pass rate over time", undefined, [
		miniBars(h, {
			values: Arr.map(
				Arr.sort(
					detail.series,
					Order.mapInput(Order.String, (bucket: (typeof detail.series)[number]) => bucket.bucket),
				),
				(bucket) => passRateOf(bucket) ?? 0,
			),
			max: 1,
			floor: 4,
			label: "Pass rate per bucket",
			className: "h-16 w-full text-primary",
		}),
	])

const breakdownTable = (h: H, rows: ReadonlyArray<AiEvaluationBreakdownRow>): Html =>
	section(h, "Where it runs", rows.length, [
		toolTable(
			h,
			[
				toolTableHead(h, [
					th(h, { label: "Service", width: columnClass({ min: "0" }) }),
					th(h, {
						label: "Environment",
						width: "w-32 shrink-0",
						hidden: "hidden @min-[720px]/panel:flex",
					}),
					th(h, { label: "Scores", width: "w-20 shrink-0", align: "right" }),
					th(h, { label: "Pass rate", width: "w-20 shrink-0", align: "right" }),
					th(h, {
						label: "Mean score",
						width: "w-24 shrink-0",
						align: "right",
						hidden: "hidden @min-[720px]/panel:flex",
					}),
				]),
				toolTableBody(
					h,
					Arr.map(rows, (row) =>
						toolTableRow(h, { attributes: [h.Key(`${row.serviceName}:${row.deploymentEnv}`)] }, [
							typography(
								h,
								{
									size: "xs",
									mono: true,
									tone: "foreground",
									truncate: true,
									className: "min-w-0 flex-1",
								},
								[row.serviceName === "" ? NO_VALUE : row.serviceName],
							),
							typography(
								h,
								{
									size: "xs",
									mono: true,
									tone: "muted",
									truncate: true,
									className: "hidden w-32 shrink-0 @min-[720px]/panel:block",
								},
								[row.deploymentEnv === "" ? NO_VALUE : row.deploymentEnv],
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
							typography(
								h,
								{
									size: "xs",
									mono: true,
									numeric: true,
									align: "right",
									tone: "muted",
									className: "hidden w-24 shrink-0 @min-[720px]/panel:block",
								},
								[meanScoreLabel(row)],
							),
						]),
					),
					{ isWaiting: false },
				),
			],
			undefined,
			{ hasShrinkingLanes: true },
		),
	])

const verdictLabel = (verdict: string): string =>
	verdict === "pass" ? "Pass" : verdict === "fail" ? "Fail" : NO_VALUE

const scoreCells = (h: H, score: AiEvaluationScore, timeZone: string): ReadonlyArray<Html> => [
	timestamp(h, {
		value: score.timestamp,
		timeZone,
		className: "hidden w-32 shrink-0 font-mono text-2xs text-muted-foreground @min-[720px]/panel:block",
	}),
	hstack(h, { gap: "1.5", align: "center", as: "span", className: "w-16 shrink-0" }, [
		statusDot(h, { tone: verdictTone(score) }),
		typography(h, { size: "xs", tone: "muted" }, [verdictLabel(score.verdict)]),
	]),
	typography(
		h,
		{
			size: "xs",
			mono: true,
			tone: "foreground",
			truncate: true,
			className: "w-36 shrink-0",
			attributes: [h.Title(scoreText(score))],
		},
		[scoreText(score)],
	),
	typography(
		h,
		{
			size: "xs",
			tone: "muted",
			truncate: true,
			className: "min-w-0 flex-1",
			attributes: [h.Title(score.explanation)],
		},
		[score.explanation === "" ? NO_VALUE : score.explanation],
	),
	typography(
		h,
		{ size: "xs", truncate: true, className: "hidden w-28 shrink-0 @min-[720px]/panel:block" },
		[
			score.sessionId === undefined
				? typography(h, { tone: "subtle" }, [NO_VALUE])
				: textLink(
						h,
						{
							tone: "inherit",
							isMono: true,
							className: "block truncate",
							href: hrefOf(
								// No time bounds: a judge can score long after the session, and the session
								// page finds its own bounds.
								AppRoute.AgentSession({
									sessionId: score.sessionId,
									search: { span: score.spanId },
								}),
							),
						},
						[score.sessionId],
					),
		],
	),
	typography(
		h,
		{ size: "2xs", truncate: true, className: "hidden w-24 shrink-0 @min-[720px]/panel:block" },
		[
			// A score written outside any trace (a session score from an offline job) links nowhere.
			score.traceId === ""
				? typography(h, { tone: "subtle" }, [NO_VALUE])
				: textLink(
						h,
						{
							tone: "muted",
							isMono: true,
							className: "block truncate",
							href: hrefOf(
								// No time hint: the score's time can be hours after the trace, outside the hint's reach.
								AppRoute.Trace({ traceId: score.traceId, search: { spanId: score.spanId } }),
							),
						},
						[Str.slice(0, 12)(score.traceId)],
					),
		],
	),
]

const scoresTable = (h: H, model: Model, detail: EvaluatorDetail, timeZone: string): Html =>
	section(h, "Latest scores", detail.scores.length, [
		toolTable(
			h,
			[
				toolTableHead(h, [
					// Time, Session and Trace hide on a phone, so the explanation keeps its room.
					th(h, {
						label: "Time",
						width: "w-32 shrink-0",
						hidden: "hidden @min-[720px]/panel:flex",
					}),
					th(h, { label: "Verdict", width: "w-16 shrink-0" }),
					th(h, { label: "Score", width: "w-36 shrink-0" }),
					th(h, { label: "Explanation", width: columnClass({ min: "0" }) }),
					th(h, {
						label: "Session",
						width: "w-28 shrink-0",
						hidden: "hidden @min-[720px]/panel:flex",
					}),
					th(h, {
						label: "Trace",
						width: "w-24 shrink-0",
						hidden: "hidden @min-[720px]/panel:flex",
					}),
				]),
				toolTableBody(
					h,
					detail.scores.length === 0
						? [
								typography(
									h,
									{ size: "xs", tone: "muted", as: "p", className: "py-8 text-center" },
									[
										model.search.failing === true
											? "No failing scores in this window"
											: "No scores in this window",
									],
								),
							]
						: Arr.map(detail.scores, (score) =>
								toolTableRow(
									h,
									{
										attributes: [
											h.Key(`${score.spanId}:${score.timestamp}:${score.source}`),
										],
									},
									scoreCells(h, score, timeZone),
								),
							),
					{ isWaiting: AsyncData.isRefreshing(model.detail.data) },
				),
			],
			undefined,
			{ hasShrinkingLanes: true },
		),
	])

const loadedView = (h: H, model: Model, detail: EvaluatorDetail, timeZone: string): Html => {
	const window = model.frame.window
	if (detail.summary === undefined || window === null)
		return vstack(h, { className: "px-6 py-16" }, [
			evalsEmptyState(h, "No scores from this evaluator in this window"),
		])
	return vstack(h, { className: "pb-6" }, [
		toolFilterToolbar(h, {
			selects: [],
			isFailingOnly: model.search.failing === true,
			onToggleFailingOnly: Message.ToggledFailingOnly(),
			isWaiting: AsyncData.isRefreshing(model.detail.data),
		}),
		summaryRow(h, detail.summary),
		// A purely numeric evaluator has no verdicts, so no pass rate to draw.
		...(detail.series.length > 1 && Arr.some(detail.series, (bucket) => passRateOf(bucket) !== undefined)
			? [passRateBars(h, detail)]
			: []),
		breakdownTable(h, detail.breakdown),
		scoresTable(h, model, detail, timeZone),
	])
}

/** The evaluator's summary, verdict trend, breakdown and scores, or their loading and error states. */
export const evaluatorBody = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.matchData(model.detail.data, {
		onEmpty: () =>
			h.div(
				[h.Class("px-6 pt-5")],
				[skeletonList(h, { rows: 5, rowClassName: "h-[38px]", className: "gap-1.5 py-3" })],
			),
		onFailure: (failure) =>
			h.div(
				[h.Class("p-4")],
				[
					errorState(h, {
						failure,
						title: "Couldn't load this evaluator",
						onRetry: Message.ClickedRetry(),
					}),
				],
			),
		onData: (detail) => loadedView(h, model, detail, timeZone),
	})

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	dashboardPage(
		h,
		{
			title: model.name,
			actions: Frame.controls(
				h,
				model.frame,
				{ search: model.search, defaultPreset: DEFAULT_EVALS_PRESET },
				toFrame,
				AsyncData.isFailure(model.detail.data),
			),
			scrollClassName: "p-0",
		},
		[evaluatorBody(h, model, inputs.context.timeZone)],
	),
)
