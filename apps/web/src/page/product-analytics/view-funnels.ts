import {
	FUNNEL_MAX_STEPS,
	FUNNEL_SESSION_DIMENSION_LABEL,
	type FunnelBreakdownBy,
	type FunnelKeyBy,
	type FunnelVariant,
} from "@maple/query-model"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"
import { Array as Arr, Option, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Chart from "@maple/views/charts/chart"
import * as FunnelChart from "@maple/views/charts/funnel-chart"
import * as FunnelDropoffChart from "@maple/views/charts/funnel-dropoff-chart"
import { fmtSpan } from "@maple/views/charts/funnel-dropoff-steps"
import { button } from "@maple/views/ui/button"
import { delta } from "@maple/views/ui/delta"
import { errorState } from "@maple/views/ui/error-state"
import { filterChip } from "@maple/views/ui/filter-chip"
import { meter } from "@maple/views/ui/meter"
import { panel, panelChartBody, panelHeader } from "@maple/views/ui/panel"
import * as Select from "@maple/views/ui/select"
import { type SelectEntry, view as selectView } from "@maple/views/ui/select-view"
import { skeletonList } from "@maple/views/ui/skeleton"
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
import {
	FUNNEL_KEY_BY_OPTIONS,
	FUNNEL_SESSION_DIMENSIONS,
	FUNNEL_WINDOW_OPTIONS,
} from "../dashboards/kit/funnel-definition"
import { parseFunnelStepFilter } from "../dashboards/widget/funnel-filters"
import { type StepDraft, StepEdit, stepBuilder, stepFilterLine } from "../kit/funnel-steps"
import { statRail, statRailItem, statRailLoading } from "../kit/stat-rail"
import { funnelOf, funnelParamsOf, hasStepFilter } from "./definition"
import { Message } from "./message"
import { type FunnelGroupRow, type FunnelRow, isCustomEvent, type Model } from "./model"
import { BREAKDOWN_SELECT_ID } from "./update"
import {
	controlsBar,
	countHeader,
	countNoun,
	emptyPanel,
	eventSuggestions,
	labelledSegment,
	mostPeopleFirst,
	pageSuggestions,
} from "./view-parts"

// The Funnels tab: the step editor, then how many reached each step and where the rest went.

type H = HtmlBuilder<Message>

const VARIANTS: ReadonlyArray<{ value: FunnelVariant; label: string }> = [
	{ value: "bars", label: "Bars" },
	{ value: "dropoff", label: "Drop-off" },
]

const WINDOWS = Arr.map(FUNNEL_WINDOW_OPTIONS, (option) => ({
	value: String(option.value),
	label: option.label,
}))

const ATTRIBUTE_PREFIX = "attribute:"

/** What a breakdown splits by, as its panel title reads: "UTM source", or the property's key. */
const breakdownLabel = (breakdownBy: FunnelBreakdownBy): string =>
	Option.match(
		Arr.findFirst(FUNNEL_SESSION_DIMENSIONS, (dimension) => dimension === breakdownBy),
		{
			onNone: () => Str.slice(ATTRIBUTE_PREFIX.length)(breakdownBy),
			onSome: (dimension) => FUNNEL_SESSION_DIMENSION_LABEL[dimension],
		},
	)

/** None, where the session came from, then the event properties this org sends. */
const breakdownEntries = (
	model: Model,
	current: FunnelBreakdownBy | undefined,
): ReadonlyArray<SelectEntry> => {
	const keys = Arr.map(
		Option.getOrElse(AsyncData.getData(model.attributeKeys.data), () => []),
		(row) => `${ATTRIBUTE_PREFIX}${row.attributeKey}`,
	)
	// A property from a shared link stays listed even when this window no longer sends it.
	const properties =
		current !== undefined && Str.startsWith(ATTRIBUTE_PREFIX)(current) && !keys.includes(current)
			? [current, ...keys]
			: keys
	return [
		{ _tag: "Item", item: { value: "", label: "None" } },
		{
			_tag: "Group",
			label: "Session",
			items: Arr.map(FUNNEL_SESSION_DIMENSIONS, (dimension) => ({
				value: dimension,
				label: FUNNEL_SESSION_DIMENSION_LABEL[dimension],
			})),
		},
		...(properties.length === 0
			? []
			: [
					{
						_tag: "Group" as const,
						label: "Event property",
						items: Arr.map(properties, (value) => ({
							value,
							label: Str.slice(ATTRIBUTE_PREFIX.length)(value),
						})),
					},
				]),
	]
}

const breakdownSelect = (h: H, model: Model, current: FunnelBreakdownBy | undefined): Html => {
	const value = current ?? ""
	const state =
		model.selects[BREAKDOWN_SELECT_ID] ?? Select.init(BREAKDOWN_SELECT_ID, { value, selectedIndex: null })
	return hstack(h, { gap: "2" }, [
		typography(h, { size: "xs", tone: "muted", className: "shrink-0" }, ["Break down by"]),
		h.submodel({
			slotId: `product-analytics-select-${BREAKDOWN_SELECT_ID}`,
			model: { ...state, value },
			view: selectView,
			toParentMessage: (message) => Message.GotSelectMessage({ id: BREAKDOWN_SELECT_ID, message }),
			viewInputs: {
				entries: breakdownEntries(model, current),
				size: "sm",
				className: "w-40 min-w-0",
				ariaLabel: "Break down by",
				toView: (parts) => h.div([h.Class("contents")], parts),
			},
		}),
	])
}

/** An event step's property filter: `plan = "pro"`, run on Enter or once typing pauses. */
const filterLine = (h: H, step: StepDraft & { kind: "event" }, index: number): Html => {
	const clause = step.filterClause ?? ""
	const parsed = parseFunnelStepFilter(clause)
	return stepFilterLine(h, {
		id: `product-analytics-step-filter-${index}`,
		index,
		value: clause,
		error: parsed.ok ? undefined : parsed.error,
		onInput: (value) =>
			Message.ChangedStep({
				scope: "funnel",
				edit: StepEdit.ChangedText({ index, field: "filterClause", value }),
			}),
		submit: { onEnter: Message.SubmittedStepFilter() },
	})
}

const editor = (h: H, model: Model): Html => {
	const funnel = funnelOf(model.search)
	const showsFilters = model.showsStepFilters || hasStepFilter(model.steps)
	return panel(h, { className: "shrink-0" }, [
		panelHeader(h, {
			title: "Steps",
			scope: typography(h, { size: "2xs", tone: "muted" }, [
				"in order, each within the window of step 1",
			]),
			action: filterChip(
				h,
				{ size: "xs", isPressed: showsFilters, onClick: Message.ToggledStepFilters() },
				["Filter by property"],
			),
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
				eventStepExtra: showsFilters ? (step, index) => filterLine(h, step, index) : undefined,
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
			breakdownSelect(h, model, funnel.breakdownBy),
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
	const custom = Arr.sort(
		Arr.filter(
			Option.getOrElse(AsyncData.getData(model.events.data), () => []),
			isCustomEvent,
		),
		mostPeopleFirst,
	).slice(0, 4)
	const pairs = Arr.map(
		custom.slice(1),
		(row, index) => [custom[index]?.eventName ?? "", row.eventName] as const,
	)
	return emptyPanel(h, "Pick the steps people take, in order", [
		"Each step is an event, a page view or, first step only, where a session came from.",
		...(pairs.length === 0
			? []
			: [
					" Or start from one of these:",
					hstack(
						h,
						{ gap: "2", wrap: true, justify: "center", className: "mt-3" },
						Arr.map(pairs, ([first, second]) =>
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
	Arr.reduce<FunnelRow, Readonly<{ name: string; share: number }> | null>(
		rows.slice(1),
		null,
		(worst, row, index) => {
			const before = rows[index]?.value ?? 0
			const share = before === 0 ? 0 : 1 - row.value / before
			return worst === null || share > worst.share ? { name: row.name, share } : worst
		},
	)

const conversionOf = (rows: ReadonlyArray<{ readonly value: number }>): number | null => {
	const entered = rows[0]?.value ?? 0
	return entered === 0 ? null : (rows.at(-1)?.value ?? 0) / entered
}

const points = (magnitude: number): string => `${(magnitude * 100).toFixed(1)} pts`

/** The same funnel over the window before, once it answered with people in it. */
const previousOf = (model: Model): ReadonlyArray<FunnelRow> | undefined => {
	const rows = Option.getOrUndefined(AsyncData.getData(model.previousFunnel.data))
	return rows === undefined || (rows[0]?.value ?? 0) === 0 ? undefined : rows
}

const stats = (h: H, model: Model, rows: ReadonlyArray<FunnelRow>, keyBy: FunnelKeyBy): Html => {
	const entered = rows[0]?.value ?? 0
	const last = rows.at(-1)
	const converted = last?.value ?? 0
	const conversion = conversionOf(rows) ?? 0
	const drop = biggestDrop(rows)
	const previous = previousOf(model)
	const previousConversion = previous === undefined ? null : conversionOf(previous)
	const hasSteps = rows.length > 1
	return statRail(h, { columns: 4 }, [
		statRailItem(h, {
			eyebrow: "Entered",
			value: formatNumber(entered),
			delta:
				previous === undefined
					? undefined
					: delta(h, { current: entered, previous: previous[0]?.value ?? 0 }),
			subline: `${countNoun(keyBy, entered)} reached step 1`,
		}),
		statRailItem(h, {
			eyebrow: "Conversion",
			eyebrowTooltip: "The share of those who entered that reached the last step inside the window.",
			value: formatPercent(conversion),
			delta:
				previousConversion === null || !hasSteps
					? undefined
					: delta(h, { ratio: conversion - previousConversion, format: points }),
			subline: last === undefined ? undefined : `${formatNumber(converted)} reached ${last.name}`,
		}),
		statRailItem(h, {
			eyebrow: "Time to convert",
			eyebrowTooltip: "From the first step to the last, for those who reached the last step.",
			value: last?.sinceStartP50Ms === undefined ? "–" : fmtSpan(last.sinceStartP50Ms),
			subline:
				last?.sinceStartP90Ms === undefined
					? hasSteps
						? "nobody converted"
						: "one step"
					: `median · 90% within ${fmtSpan(last.sinceStartP90Ms)}`,
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
	// The bars need a row per step; the drop-off columns want the height.
	const height = isDropoff ? "h-80" : rows.length <= 3 ? "h-44" : rows.length <= 6 ? "h-60" : "h-80"
	const inputs = { data: rows, className: height, isSingleHue: true }
	return isDropoff
		? h.submodel({ ...common, view: FunnelDropoffChart.view, viewInputs: inputs })
		: h.submodel({ ...common, view: FunnelChart.view, viewInputs: inputs })
}

const LEAVERS_SHOWN = 3

/** Where those who dropped before this step went, as shares of everyone who dropped. */
const leaversCell = (h: H, row: FunnelRow, dropped: number): Html => {
	const leavers = (row.leavers ?? []).slice(0, LEAVERS_SHOWN)
	if (leavers.length === 0 || dropped <= 0) return typography(h, { tone: "muted" }, ["–"])
	return hstack(
		h,
		{ wrap: true, className: "gap-x-3 gap-y-0.5" },
		Arr.map(leavers, (leaver) =>
			hstack(h, { gap: "1.5", align: "baseline", shrink: true, attributes: [h.Key(leaver.name)] }, [
				leaver.name === ""
					? typography(h, { size: "xs", tone: "muted", truncate: true }, ["nothing after"])
					: typography(h, { size: "xs", mono: true, truncate: true }, [leaver.name]),
				typography(h, { size: "2xs", tone: "muted", numeric: true, className: "shrink-0" }, [
					formatPercent(Math.min(1, leaver.count / dropped)),
				]),
			]),
		),
	)
}

const stepsTable = (h: H, rows: ReadonlyArray<FunnelRow>, keyBy: FunnelKeyBy): Html => {
	const entered = rows[0]?.value ?? 0
	return table(h, { variant: "bare", size: "sm", ariaLabel: "Funnel steps" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Step"]),
				tableHead(h, [countHeader(keyBy)], "text-right"),
				tableHead(h, ["Of entered"], "text-right"),
				tableHead(h, ["From previous"], "text-right"),
				tableHead(h, ["Dropped"], "text-right"),
				tableHead(h, ["Time from previous"], "text-right"),
				tableHead(h, ["Leavers did next"]),
			]),
		]),
		tableBody(
			h,
			Arr.map(rows, (row, index) => {
				const before = index === 0 ? 0 : (rows[index - 1]?.value ?? 0)
				const dropped = Math.max(0, before - row.value)
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
						numericTableCell(h, [entered === 0 ? "–" : formatPercent(row.value / entered)]),
						numericTableCell(h, [before === 0 ? "–" : formatPercent(row.value / before)]),
						numericTableCell(h, [index === 0 ? "–" : formatNumber(dropped)]),
						numericTableCell(
							h,
							row.p50Ms === undefined
								? ["–"]
								: [
										fmtSpan(row.p50Ms),
										...(row.p90Ms === undefined
											? []
											: [
													typography(
														h,
														{ size: "2xs", tone: "muted", className: "ml-1.5" },
														[`p90 ${fmtSpan(row.p90Ms)}`],
													),
												]),
									],
						),
						tableCell(h, [
							index === 0
								? typography(h, { tone: "muted" }, ["–"])
								: leaversCell(h, row, dropped),
						]),
					],
					undefined,
					[h.Key(`${index}:${row.name}`)],
				)
			}),
		),
	])
}

type Group = Readonly<{ name: string; entered: number; converted: number }>

/** The grouped rows as one line per group: who entered and who reached the last step. */
const groupsOf = (rows: ReadonlyArray<FunnelGroupRow>): ReadonlyArray<Group> =>
	Arr.map(Arr.dedupe(Arr.map(rows, (row) => row.group)), (name) => {
		const steps = Arr.filter(rows, (row) => row.group === name)
		return { name, entered: steps[0]?.value ?? 0, converted: steps.at(-1)?.value ?? 0 }
	})

const breakdownTable = (
	h: H,
	groups: ReadonlyArray<Group>,
	inputs: Readonly<{ label: string; keyBy: FunnelKeyBy; overall: number }>,
): Html => {
	const best = Arr.reduce(groups, 0, (max, group) =>
		Math.max(max, group.entered === 0 ? 0 : group.converted / group.entered),
	)
	return table(h, { variant: "bare", size: "sm", ariaLabel: `Conversion by ${inputs.label}` }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, [inputs.label]),
				tableHead(h, ["Entered"], "text-right"),
				tableHead(h, ["Converted"], "text-right"),
				tableHead(h, ["Conversion"], "w-2/5"),
				tableHead(h, ["Vs everyone"], "text-right"),
			]),
		]),
		tableBody(
			h,
			Arr.map(groups, (group) => {
				const conversion = group.entered === 0 ? 0 : group.converted / group.entered
				return tableRow(
					h,
					[
						tableCell(h, [typography(h, { size: "xs", truncate: true }, [group.name])]),
						numericTableCell(h, [formatNumber(group.entered)]),
						numericTableCell(h, [formatNumber(group.converted)]),
						tableCell(h, [
							hstack(h, { gap: "2.5" }, [
								typography(
									h,
									{ size: "xs", numeric: true, className: "w-12 shrink-0 text-right" },
									[formatPercent(conversion)],
								),
								meter(h, {
									value: conversion,
									max: best === 0 ? 1 : best,
									className: "flex-1",
									fillClassName: "bg-chart-2",
								}),
							]),
						]),
						numericTableCell(h, [
							delta(h, { ratio: conversion - inputs.overall, format: points }),
						]),
					],
					undefined,
					[h.Key(group.name)],
				)
			}),
		),
	])
}

/** The breakdown's panel: a line per group, most entered first, compared with the whole funnel. */
const breakdown = (
	h: H,
	model: Model,
	breakdownBy: FunnelBreakdownBy,
	inputs: Readonly<{ keyBy: FunnelKeyBy; overall: number }>,
): Html => {
	const label = breakdownLabel(breakdownBy)
	return panel(h, {}, [
		panelHeader(h, {
			title: `By ${label}`,
			scope: typography(h, { size: "2xs", tone: "muted" }, [
				`each ${countNoun(inputs.keyBy, 1)} counts under the first value seen, most entered first`,
			]),
		}),
		AsyncData.isRefreshing(model.funnelBreakdown.data)
			? skeletonList(h, { rows: 4, className: "p-3" })
			: AsyncData.matchData(model.funnelBreakdown.data, {
					onEmpty: () => skeletonList(h, { rows: 4, className: "p-3" }),
					onFailure: (failure) =>
						errorState(h, {
							failure,
							title: "Couldn't split the funnel",
							onRetry: Message.ClickedRetry({ slot: "funnelBreakdown" }),
						}),
					onData: (rows) => breakdownTable(h, groupsOf(rows), { label, ...inputs }),
				}),
	])
}

const results = (h: H, model: Model): Html =>
	// A refetch after a Count by or view change would draw the old counts under the new labels.
	AsyncData.isRefreshing(model.funnel.data)
		? statRailLoading(h, 4, 4)
		: AsyncData.matchData(model.funnel.data, {
				onEmpty: () => statRailLoading(h, 4, 4),
				onFailure: (failure) =>
					errorState(h, {
						failure,
						title: "Couldn't run the funnel",
						onRetry: Message.ClickedRetry({ slot: "funnel" }),
					}),
				onData: (rows) => {
					const { keyBy, variant, breakdownBy } = funnelOf(model.search)
					const isDropoff = variant === "dropoff"
					const entered = rows[0]?.value ?? 0
					if (entered === 0)
						return emptyPanel(h, "Nobody reached step 1 in this window", [
							"Check the first step's name, widen the time range, or clear the filters.",
						])
					return vstack(h, { gap: "4" }, [
						stats(h, model, rows, keyBy),
						panel(h, {}, [
							panelHeader(h, {
								title: isDropoff ? "Drop-off" : "Conversion",
								scope: typography(h, { size: "2xs", tone: "muted" }, [
									`${formatNumber(entered)} ${countNoun(keyBy, entered)} entered`,
								]),
							}),
							panelChartBody(h, [chart(h, model, rows, isDropoff)]),
						]),
						...(breakdownBy === undefined || rows.length < 2
							? []
							: [
									breakdown(h, model, breakdownBy, {
										keyBy,
										overall: conversionOf(rows) ?? 0,
									}),
								]),
						panel(h, {}, [panelHeader(h, { title: "Steps" }), stepsTable(h, rows, keyBy)]),
					])
				},
			})

export const funnelsTab = (h: H, model: Model): Html =>
	vstack(h, { gap: "4" }, [
		editor(h, model),
		funnelParamsOf(model.search) === null ? suggestions(h, model) : results(h, model),
	])
