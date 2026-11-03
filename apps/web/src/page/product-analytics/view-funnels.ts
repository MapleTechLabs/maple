import { FUNNEL_MAX_STEPS, type FunnelKeyBy, type FunnelVariant } from "@maple/query-model"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Chart from "@maple/views/charts/chart"
import * as FunnelChart from "@maple/views/charts/funnel-chart"
import * as FunnelDropoffChart from "@maple/views/charts/funnel-dropoff-chart"
import { fmtSpan } from "@maple/views/charts/funnel-dropoff-steps"
import { button } from "@maple/views/ui/button"
import { errorState } from "@maple/views/ui/error-state"
import { panel, panelChartBody, panelHeader } from "@maple/views/ui/panel"
import { hstack, vstack } from "@maple/views/ui/stack"
import {
	numericTableCell,
	table,
	tableBody,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
} from "@maple/views/ui/table"
import { typography } from "@maple/views/ui/typography"
import { FUNNEL_KEY_BY_OPTIONS, FUNNEL_WINDOW_OPTIONS } from "../../components/funnels/definition"
import { stepBuilder } from "../kit/funnel-steps"
import { statRail, statRailItem, statRailLoading } from "../kit/stat-rail"
import { funnelOf, funnelParamsOf } from "./definition"
import { Message } from "./message"
import { type FunnelRow, isCustomEvent, type Model } from "./model"
import {
	controlsBar,
	countHeader,
	countNoun,
	emptyPanel,
	eventSuggestions,
	labelledSegment,
	pageSuggestions,
} from "./view-parts"

// The Funnels tab: the step editor, then how many reached each step and where the rest went.

type H = HtmlBuilder<Message>

const VARIANTS: ReadonlyArray<{ value: FunnelVariant; label: string }> = [
	{ value: "bars", label: "Bars" },
	{ value: "dropoff", label: "Drop-off" },
]

const WINDOWS = FUNNEL_WINDOW_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))

const editor = (h: H, model: Model): Html => {
	const funnel = funnelOf(model.search)
	return panel(h, { className: "shrink-0" }, [
		panelHeader(h, {
			title: "Steps",
			scope: typography(h, { size: "2xs", tone: "muted" }, [
				"in order, each within the window of step 1",
			]),
		}),
		vstack(h, { className: "p-3" }, [
			stepBuilder(h, {
				scope: "funnel",
				slotPrefix: "product-analytics",
				steps: model.steps,
				eventNames: eventSuggestions(model),
				pagePaths: pageSuggestions(model),
				maxSteps: FUNNEL_MAX_STEPS,
				combos: model.stepCombos,
				selects: model.selects,
				onCombo: (id, message) => Message.GotStepComboMessage({ id, message }),
				onSelect: (id, message) => Message.GotSelectMessage({ id, message }),
				onEdit: (edit) => Message.ChangedStep({ scope: "funnel", edit }),
			}),
		]),
		controlsBar(h, [
			labelledSegment<FunnelKeyBy>(h, {
				label: "Count by",
				value: funnel.keyBy,
				options: FUNNEL_KEY_BY_OPTIONS,
				onChange: (keyBy) => Message.PickedKeyBy({ keyBy }),
			}),
			labelledSegment(h, {
				label: "Within",
				value: String(funnel.windowSeconds),
				options: WINDOWS,
				onChange: (seconds) => Message.PickedWindow({ seconds: Number(seconds) }),
			}),
			hstack(h, { className: "ml-auto" }, [
				labelledSegment(h, {
					label: "View",
					value: funnel.variant,
					options: VARIANTS,
					onChange: (variant) => Message.PickedVariant({ variant }),
				}),
			]),
		]),
	])
}

/** Starting points from the events this org sends: the most reached custom events, two at a time. */
const suggestions = (h: H, model: Model): Html => {
	const custom = Option.getOrElse(AsyncData.getData(model.events.data), () => [])
		.filter(isCustomEvent)
		.toSorted((a, b) => b.persons - a.persons)
		.slice(0, 4)
	const pairs = custom
		.slice(1)
		.map((row, index) => [custom[index]?.eventName ?? "", row.eventName] as const)
	return emptyPanel(h, "Pick the steps people take, in order", [
		"Each step is an event, a page view or, first step only, where a session came from.",
		...(pairs.length === 0
			? []
			: [
					" Or start from one of these:",
					hstack(
						h,
						{ gap: "2", wrap: true, justify: "center", className: "mt-3" },
						pairs.map(([first, second]) =>
							button(
								h,
								{
									variant: "outline",
									size: "sm",
									attributes: [
										h.Key(`${first}>${second}`),
										h.OnClick(
											Message.ClickedSuggestedFunnel({
												steps: [
													{ kind: "event", eventName: first },
													{ kind: "event", eventName: second },
												],
											}),
										),
									],
								},
								[typography(h, { size: "xs", mono: true }, [`${first} → ${second}`])],
							),
						),
					),
				]),
	])
}

/** The step that loses the largest share of those who reached the one before it. */
const biggestDrop = (rows: ReadonlyArray<FunnelRow>): Readonly<{ name: string; share: number }> | null =>
	rows.slice(1).reduce<Readonly<{ name: string; share: number }> | null>((worst, row, index) => {
		const before = rows[index]?.value ?? 0
		const share = before === 0 ? 0 : 1 - row.value / before
		return worst === null || share > worst.share ? { name: row.name, share } : worst
	}, null)

const stats = (h: H, rows: ReadonlyArray<FunnelRow>): Html => {
	const entered = rows[0]?.value ?? 0
	const last = rows.at(-1)
	const drop = biggestDrop(rows)
	return statRail(h, { columns: 4 }, [
		statRailItem(h, { eyebrow: "Entered", value: formatNumber(entered), subline: "reached step 1" }),
		statRailItem(h, {
			eyebrow: "Converted",
			value: formatNumber(last?.value ?? 0),
			subline: last === undefined ? undefined : `reached ${last.name}`,
		}),
		statRailItem(h, {
			eyebrow: "Conversion",
			value: formatPercent(entered === 0 ? 0 : (last?.value ?? 0) / entered),
		}),
		statRailItem(h, {
			eyebrow: "Biggest drop",
			value: drop === null ? "–" : formatPercent(drop.share),
			subline: drop === null ? "one step" : `before ${drop.name}`,
		}),
	])
}

const chart = (h: H, model: Model, rows: ReadonlyArray<FunnelRow>, isDropoff: boolean): Html => {
	const common = {
		slotId: "product-analytics-funnel",
		model: model.chart,
		toParentMessage: (message: Chart.Message) => Message.GotChartMessage({ message }),
	}
	const inputs = { data: rows, className: "h-80" }
	return isDropoff
		? h.submodel({ ...common, view: FunnelDropoffChart.view, viewInputs: inputs })
		: h.submodel({ ...common, view: FunnelChart.view, viewInputs: inputs })
}

const stepsTable = (h: H, rows: ReadonlyArray<FunnelRow>, keyBy: FunnelKeyBy, hasDetails: boolean): Html => {
	const entered = rows[0]?.value ?? 0
	return table(h, { variant: "bare", size: "sm", ariaLabel: "Funnel steps" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Step"]),
				tableHead(h, [countHeader(keyBy)], "text-right"),
				tableHead(h, ["From previous"], "text-right"),
				tableHead(h, ["From start"], "text-right"),
				...(hasDetails
					? [tableHead(h, ["Median time"], "text-right"), tableHead(h, ["Leavers did next"])]
					: []),
			]),
		]),
		tableBody(
			h,
			rows.map((row, index) => {
				const before = index === 0 ? 0 : (rows[index - 1]?.value ?? 0)
				const leaver = row.leavers?.[0]
				return tableRow(
					h,
					[
						tableCell(h, [
							hstack(h, { gap: "2" }, [
								typography(
									h,
									{ size: "2xs", tone: "muted", numeric: true, className: "w-4" },
									[String(index + 1)],
								),
								typography(h, { size: "xs", mono: true, truncate: true }, [row.name]),
							]),
						]),
						numericTableCell(h, [formatNumber(row.value)]),
						numericTableCell(h, [before === 0 ? "–" : formatPercent(row.value / before)]),
						numericTableCell(h, [entered === 0 ? "–" : formatPercent(row.value / entered)]),
						...(hasDetails
							? [
									numericTableCell(h, [row.p50Ms === undefined ? "–" : fmtSpan(row.p50Ms)]),
									tableCell(h, [
										leaver === undefined
											? "–"
											: typography(
													h,
													{ size: "xs", mono: true, tone: "muted", truncate: true },
													[leaver.name === "" ? "(nothing)" : leaver.name],
												),
									]),
								]
							: []),
					],
					undefined,
					[h.Key(`${index}:${row.name}`)],
				)
			}),
		),
	])
}

const results = (h: H, model: Model): Html =>
	AsyncData.matchData(model.funnel.data, {
		onEmpty: () => statRailLoading(h, 4, 4),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't run the funnel",
				onRetry: Message.ClickedRetry({ slot: "funnel" }),
			}),
		onData: (rows) => {
			const { keyBy, variant } = funnelOf(model.search)
			// A bars answer still on screen while the drop-off details load draws as bars.
			const hasDetails = rows
				.slice(1)
				.some((row) => row.p50Ms !== undefined || row.leavers !== undefined)
			const isDropoff = variant === "dropoff" && (rows.length < 2 || hasDetails)
			const entered = rows[0]?.value ?? 0
			if (entered === 0)
				return emptyPanel(h, "Nobody reached step 1 in this window", [
					"Check the first step's name, widen the time range, or clear the filters.",
				])
			return vstack(h, { gap: "4" }, [
				stats(h, rows),
				panel(h, {}, [
					panelHeader(h, {
						title: isDropoff ? "Drop-off" : "Conversion",
						scope: typography(h, { size: "2xs", tone: "muted" }, [
							`${formatNumber(entered)} ${countNoun(keyBy, entered)} entered`,
						]),
					}),
					panelChartBody(h, [chart(h, model, rows, isDropoff)]),
				]),
				panel(h, {}, [panelHeader(h, { title: "Steps" }), stepsTable(h, rows, keyBy, isDropoff)]),
			])
		},
	})

export const funnelsTab = (h: H, model: Model): Html =>
	vstack(h, { gap: "4" }, [
		editor(h, model),
		funnelParamsOf(model.search) === null ? suggestions(h, model) : results(h, model),
	])
