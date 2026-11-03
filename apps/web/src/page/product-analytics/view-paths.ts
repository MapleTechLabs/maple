import {
	PATHS_MAX_BRANCHES,
	PATHS_MAX_DEPTH,
	PATHS_OTHER,
	type PathsAnchor,
	type PathsDirection,
} from "@maple/query-model"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"
import { Array as Arr, Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as PathsChart from "@maple/views/charts/paths-chart"
import { button } from "@maple/views/ui/button"
import { emptyMessage } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
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
import { tableSkeleton } from "@maple/views/ui/table-skeleton"
import { typography } from "@maple/views/ui/typography"
import { stepBuilder } from "../kit/funnel-steps"
import { anchorNameOf, pathsOf, pathsParamsOf } from "./definition"
import { Message } from "./message"
import type { Model, PathsRow } from "./model"
import {
	controlsBar,
	countNoun,
	emptyPanel,
	eventSuggestions,
	labelledSegment,
	pageSuggestions,
} from "./view-parts"

// The Paths tab: what people did in the steps after (or before) one event or page.

type H = HtmlBuilder<Message>

const DIRECTIONS: ReadonlyArray<{ value: PathsDirection; label: string }> = [
	{ value: "after", label: "After" },
	{ value: "before", label: "Before" },
]
const DEPTHS = Array.from({ length: PATHS_MAX_DEPTH }, (_, index) => ({
	value: String(index + 1),
	label: String(index + 1),
}))
const BRANCHES = [3, 4, 6, PATHS_MAX_BRANCHES].map((value) => ({
	value: String(value),
	label: String(value),
}))

const editor = (h: H, model: Model): Html => {
	const paths = pathsOf(model.search)
	return panel(h, { className: "shrink-0" }, [
		vstack(h, { gap: "2", className: "p-3" }, [
			labelledSegment(
				h,
				{
					label: "Direction",
					value: paths.direction,
					options: DIRECTIONS,
					onChange: (direction) => Message.PickedDirection({ direction }),
				},
				[
					typography(h, { size: "2xs", tone: "muted" }, [
						paths.direction === "after"
							? "what people did next, from the first time they reached this"
							: "how people got here, back from the last time they reached this",
					]),
				],
			),
			stepBuilder(h, {
				scope: "paths",
				slotPrefix: "product-analytics",
				steps: [model.anchor],
				eventNames: eventSuggestions(model),
				pagePaths: pageSuggestions(model),
				maxSteps: 1,
				combos: model.stepCombos,
				selects: model.selects,
				onCombo: (id, message) => Message.GotStepComboMessage({ id, message }),
				onSelect: (id, message) => Message.GotSelectMessage({ id, message }),
				onEdit: (edit) => Message.ChangedStep({ scope: "paths", edit }),
			}),
		]),
		controlsBar(h, [
			labelledSegment(h, {
				label: "Steps",
				value: String(paths.depth),
				options: DEPTHS,
				onChange: (depth) => Message.PickedDepth({ depth: Number(depth) }),
			}),
			labelledSegment(
				h,
				{
					label: "Branches",
					value: String(paths.branches),
					options: BRANCHES,
					onChange: (branches) => Message.PickedBranches({ branches: Number(branches) }),
				},
				[typography(h, { size: "2xs", tone: "muted" }, ["named per step, the rest fold into Other"])],
			),
		]),
	])
}

/** A path node's name as people read it. */
const nodeLabel = (name: string): string => (name === PATHS_OTHER ? "Other" : name === "" ? "(ended)" : name)

/**
 * A node as the anchor of a new paths view. The query names page views by path and events by name,
 * so a known event name is an event and anything else starting with `/` is a page.
 */
const anchorOf = (name: string, eventNames: ReadonlySet<string>): PathsAnchor =>
	!eventNames.has(name) && name.startsWith("/")
		? { kind: "page", pagePath: name }
		: { kind: "event", eventName: name }

type Tally = Readonly<{ name: string; count: number }>

const tally = (rows: ReadonlyArray<PathsRow>, pick: (row: PathsRow) => string): ReadonlyArray<Tally> => {
	const counts = new Map<string, number>()
	rows.forEach((row) => counts.set(pick(row), (counts.get(pick(row)) ?? 0) + row.count))
	return [...counts].map(([name, count]) => ({ name, count })).toSorted((a, b) => b.count - a.count)
}

/** The first hop's nodes: what people did right after (or before) the anchor. */
const nextSteps = (rows: ReadonlyArray<PathsRow>): ReadonlyArray<Tally> =>
	tally(
		rows.filter((row) => row.hop === 1 && row.toNode !== ""),
		(row) => row.toNode,
	)

/** Where a sequence stopped: the node a hop into `''` left from. At most depth × (branches + 1) rows. */
const endings = (rows: ReadonlyArray<PathsRow>): ReadonlyArray<Tally> =>
	tally(
		rows.filter((row) => row.toNode === ""),
		(row) => row.fromNode,
	)

/** Everyone who reached the anchor: each of them has exactly one first hop. */
const anchorTotal = (rows: ReadonlyArray<PathsRow>): number =>
	rows.filter((row) => row.hop === 1).reduce((total, row) => total + row.count, 0)

const tallyTable = (
	h: H,
	model: Model,
	options: Readonly<{ label: string; rows: ReadonlyArray<Tally>; total: number; empty: string }>,
): Html => {
	if (options.rows.length === 0) return emptyMessage(h, { className: "py-6" }, [options.empty])
	const eventNames = new Set(
		Option.getOrElse(AsyncData.getData(model.events.data), () => []).map((row) => row.eventName),
	)
	return table(h, { variant: "bare", size: "sm", ariaLabel: options.label }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, [options.label]),
				tableHead(h, ["People"], "text-right"),
				tableHead(h, ["Share"], "text-right"),
				tableHead(h, [typography(h, { className: "sr-only" }, ["Actions"])]),
			]),
		]),
		tableBody(
			h,
			Arr.map(options.rows, (row) =>
				tableRow(
					h,
					[
						tableCell(
							h,
							[
								typography(h, { size: "xs", mono: true, truncate: true }, [
									nodeLabel(row.name),
								]),
							],
							"max-w-60",
						),
						numericTableCell(h, [formatNumber(row.count)]),
						numericTableCell(h, [
							options.total === 0 ? "–" : formatPercent(row.count / options.total),
						]),
						tableCell(
							h,
							row.name === PATHS_OTHER
								? []
								: [
										button(
											h,
											{
												variant: "ghost",
												size: "xs",
												attributes: [
													h.AriaLabel(`Paths from ${row.name}`),
													h.OnClick(
														Message.ClickedStartPaths({
															anchor: anchorOf(row.name, eventNames),
														}),
													),
												],
											},
											[icon(h, "BranchForkIcon"), "Paths from here"],
										),
									],
							"w-px",
						),
					],
					undefined,
					[h.Key(row.name)],
				),
			),
		),
	])
}

const loading = (h: H): Html => panel(h, {}, [tableSkeleton(h, { columns: 4, rows: 6 })])

const results = (h: H, model: Model): Html => {
	const paths = pathsOf(model.search)
	// A refetch after a direction or anchor change would draw the old hops under the new heading.
	if (AsyncData.isRefreshing(model.paths.data)) return loading(h)
	return AsyncData.matchData(model.paths.data, {
		onEmpty: () => loading(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load the paths",
				onRetry: Message.ClickedRetry({ slot: "paths" }),
			}),
		onData: (rows) => {
			const total = anchorTotal(rows)
			if (rows.length === 0)
				return emptyPanel(h, "Nobody reached this in this window", [
					"Check the name, widen the time range, or clear the filters.",
				])
			return vstack(h, { gap: "4" }, [
				panel(h, {}, [
					panelHeader(h, {
						title: hstack(h, { gap: "1.5", as: "span" }, [
							paths.direction === "after" ? "What people did after" : "How people got to",
							typography(h, { size: "sm", mono: true, as: "span" }, [
								anchorNameOf(paths.anchor),
							]),
						]),
						scope: typography(h, { size: "2xs", tone: "muted" }, [
							`${formatNumber(total)} ${countNoun("person", total)} · repeats collapsed`,
						]),
					}),
					panelChartBody(h, [
						h.submodel({
							slotId: "product-analytics-paths",
							model: model.chart,
							view: PathsChart.view,
							toParentMessage: (message) => Message.GotChartMessage({ message }),
							viewInputs: { data: rows, className: "h-96", direction: paths.direction },
						}),
					]),
				]),
				h.div(
					[h.Class("grid gap-4 lg:grid-cols-2")],
					[
						panel(h, {}, [
							panelHeader(h, {
								title:
									paths.direction === "after"
										? "Most common next step"
										: "Most common step before",
							}),
							tallyTable(h, model, {
								label: "Event or page",
								rows: nextSteps(rows),
								total,
								empty:
									paths.direction === "after" ? "Nothing followed" : "Nothing came before",
							}),
						]),
						panel(h, {}, [
							// Walking back from the anchor, a sequence that runs out is where it began.
							panelHeader(h, {
								title:
									paths.direction === "after"
										? "Where sequences ended"
										: "Where sequences started",
							}),
							tallyTable(h, model, {
								label:
									paths.direction === "after"
										? "Last event or page"
										: "First event or page",
								rows: endings(rows),
								total,
								empty: "Every sequence ran the full number of steps",
							}),
						]),
					],
				),
			])
		},
	})
}

export const pathsTab = (h: H, model: Model): Html =>
	vstack(h, { gap: "4" }, [
		editor(h, model),
		pathsParamsOf(model.search) === null
			? emptyPanel(h, "Pick an event or a page", [
					"Paths shows the most common sequences after it (or before it), a few steps deep.",
				])
			: results(h, model),
	])
