import { formatBytes, formatDuration, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { Array as Arr, Option, String as Str } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../ui/button"
import { compactSearchInput } from "../ui/compact-search-input"
import { XmarkIcon } from "../ui/control-icons"
import { kbd } from "../ui/display"
import { emptyMessage } from "../ui/empty"
import { iconNode } from "../ui/icon"
import { stripClass } from "../ui/rule"
import { segmentedSelect, type SegmentedOption } from "../ui/segmented-select"
import { hstack, vstack } from "../ui/stack"
import {
	numericTableCell,
	table,
	tableBody,
	tableHead,
	tableHeader,
	tableRow,
	truncatedTableCell,
} from "../ui/table"
import { tooltipTrigger } from "../ui/tooltip-host"
import { typography } from "../ui/typography"
import { type FlameNode, layoutFlame } from "./flame-geometry"
import {
	FLAME_REVISION_ATTRIBUTE,
	type FrameScope,
	Message,
	type Model,
	MountFlameChart,
	publishFlameProps,
} from "./profile-flamegraph"
import {
	type FunctionTotal,
	matchedValue,
	type ProfileInput,
	type ProfileNode,
	profileTree,
	scopedStacks,
	topFunctions,
} from "./profile-tree"

// The view of the profile flame chart: its header, the canvas it mounts, the selected frame's
// details, and the top functions read off the same stacks.

const SCOPE_OPTIONS: ReadonlyArray<SegmentedOption<FrameScope>> = [
	{ value: "all", label: "All frames" },
	{ value: "app", label: "Own code" },
]

/** Rows of stack the chart shows before it scrolls. */
const DEFAULT_MAX_ROWS = 22

const HINT_KBD = "h-4 font-mono text-4xs"

/** A profile value in its unit: CPU or wall time, bytes, or a plain count. */
/** What `profileSummary` reads of a profile. */
export interface ProfileTotals {
	readonly sampleType: string
	readonly sampleUnit: string
	readonly totalValue: number
	readonly totalStacks: number
	readonly durationNano: number
	/** The stacks read, which a capped read leaves short of `totalStacks`. */
	readonly stacks: ReadonlyArray<unknown>
}

/** The profile's total and stack count. Only CPU time reads as time on CPU and average cores. */
export const profileSummary = (profile: ProfileTotals): string => {
	const stacks =
		profile.stacks.length < profile.totalStacks
			? `heaviest ${formatNumber(profile.stacks.length)} of ${formatNumber(profile.totalStacks)} distinct stacks`
			: `${formatNumber(profile.totalStacks)} distinct stacks`
	const value = formatProfileValue(profile.totalValue, profile.sampleUnit)
	if (profile.sampleType !== "cpu") return `${value}, ${stacks}`
	if (profile.sampleUnit !== "nanoseconds" || profile.durationNano === 0)
		return `${value} on CPU, ${stacks}`
	const cores = profile.totalValue / profile.durationNano
	return `${value} on CPU, ${cores.toFixed(2)} cores on average, ${stacks}`
}

export const formatProfileValue = (value: number, unit: string): string => {
	if (unit === "nanoseconds") return formatDuration(value / 1_000_000)
	if (unit === "bytes") return formatBytes(value)
	return formatNumber(value)
}

const sourceOf = (frame: Pick<ProfileNode, "file" | "line">): string =>
	frame.file === "" ? "" : frame.line > 0 ? `${frame.file}:${frame.line}` : frame.file

/** A source short enough for a table cell: from the package for a dependency, else the last folders. */
export const shortSource = (frame: Pick<ProfileNode, "file" | "line">): string => {
	if (frame.file === "") return ""
	const marker = "node_modules/"
	const path = Option.match(Str.lastIndexOf(marker)(frame.file), {
		onNone: () => Arr.join(Arr.takeRight(Str.split(frame.file, "/"), 3), "/"),
		onSome: (at) => Str.slice(at + marker.length)(frame.file),
	})
	return frame.line > 0 ? `${path}:${frame.line}` : path
}

const share = (part: number, whole: number): string => formatPercent(whole === 0 ? 0 : part / whole)

const header = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	root: ProfileNode,
	unit: string,
	toMessage: (message: Message) => M,
): Html =>
	// In a narrow panel the controls drop under the title instead of running into it.
	hstack(h, { align: "center", justify: "between", gap: "3", wrap: true, className: stripClass("bar") }, [
		hstack(
			h,
			{ gap: "2", align: "center", className: "min-w-0 text-xs font-medium text-muted-foreground" },
			[
				typography(h, { tone: "foreground", className: "whitespace-nowrap" }, ["Flame graph"]),
				typography(h, { tone: "subtle", numeric: true }, [formatProfileValue(root.total, unit)]),
				...(model.search === ""
					? []
					: [
							typography(h, { tone: "subtle", numeric: true }, [
								`${share(matchedValue(root, model.search), root.total)} matches`,
							]),
						]),
			],
		),
		hstack(h, { gap: "2", align: "center", className: "min-w-0" }, [
			...(model.isZoomed
				? [
						button(
							h,
							{
								variant: "ghost",
								size: "sm",
								className: "h-6 gap-1 text-xs",
								attributes: [h.OnClick(toMessage(Message.ClickedReset()))],
							},
							[iconNode(h, XmarkIcon, "XmarkIcon"), "Reset zoom"],
						),
					]
				: []),
			segmentedSelect(h, {
				options: SCOPE_OPTIONS,
				value: model.scope,
				onChange: (scope) => toMessage(Message.ChangedScope({ scope })),
				size: "xs",
				ariaLabel: "Frames shown",
			}),
			compactSearchInput(h, {
				value: model.search,
				placeholder: "Search functions",
				ariaLabel: "Search functions in the flame graph",
				onInput: (value) => toMessage(Message.ChangedSearch({ value })),
				onClear: toMessage(Message.ClearedSearch()),
				className: "w-44 min-w-0 shrink",
			}),
		]),
	])

const stat = <M>(h: HtmlBuilder<M>, label: string, value: string): Html =>
	vstack(h, { gap: "0.5", className: "shrink-0" }, [
		typography(h, { size: "2xs", tone: "muted" }, [label]),
		typography(h, { size: "xs", numeric: true, weight: "medium" }, [value]),
	])

/** The selected frame: what it is, where it lives, and how much of its caller and the profile it is. */
const selection = <M>(h: HtmlBuilder<M>, frame: FlameNode, root: ProfileNode, unit: string): Html => {
	const { node, parent } = frame
	return hstack(h, { gap: "5", align: "center", wrap: true, className: "border-t px-3 py-2" }, [
		vstack(h, { gap: "0.5", className: "min-w-0 flex-1 basis-48" }, [
			typography(h, { size: "xs", mono: true, weight: "medium", truncate: true }, [node.name]),
			typography(h, { size: "2xs", mono: true, tone: "muted", truncate: true }, [
				sourceOf(node) === "" ? "No source location" : sourceOf(node),
			]),
		]),
		stat(h, "Self", formatProfileValue(node.self, unit)),
		stat(h, "Total", formatProfileValue(node.total, unit)),
		stat(h, "Of profile", share(node.total, root.total)),
		...(parent === null || parent.node.id === root.id
			? []
			: [stat(h, "Of its caller", share(node.total, parent.node.total))]),
	])
}

const hint = <M>(h: HtmlBuilder<M>, keys: string, label: string): Html =>
	h.span([h.Class("whitespace-nowrap")], [kbd(h, HINT_KBD, [keys]), ` ${label}`])

const footer = <M>(h: HtmlBuilder<M>, stacks: number, isCompact: boolean): Html =>
	hstack(
		h,
		{
			align: "center",
			justify: "between",
			gap: "3",
			wrap: true,
			className: "border-t bg-surface-sunken px-3 py-1.5 text-3xs text-muted-foreground",
		},
		[
			hstack(h, { gap: "3", align: "center", wrap: true }, [
				hint(h, "Ctrl + scroll", "zoom"),
				hint(h, "Drag", "pan"),
				// A narrow panel keeps the two gestures nobody would guess.
				...(isCompact
					? []
					: [
							hint(h, "W A S D", "navigate"),
							hint(h, "Double-click", "zoom to frame"),
							hint(h, "Esc", "zoom out, then deselect"),
						]),
			]),
			typography(h, { numeric: true }, [`${formatNumber(stacks)} stacks`]),
		],
	)

interface FunctionsOptions {
	readonly unit: string
	readonly limit: number
	/** The flame graph's scope, so the table ranks the same frames it draws. */
	readonly scope?: FrameScope
	/** A narrow panel: the source moves under the name and the share column goes. */
	readonly compact?: boolean
}

const functionRow = <M>(
	h: HtmlBuilder<M>,
	row: FunctionTotal,
	total: number,
	options: FunctionsOptions,
): Html => {
	const source = typography(h, { mono: true, size: "xs", tone: "muted", truncate: true }, [
		shortSource(row),
	])
	const name = typography(h, { mono: true, size: "xs", truncate: true }, [row.name])
	const titled = tooltipTrigger(h, sourceOf(row) === "" ? row.name : `${row.name}\n${sourceOf(row)}`)
	return tableRow(h, [
		...(options.compact === true
			? [
					truncatedTableCell(
						h,
						[vstack(h, { gap: "0.5", className: "min-w-0" }, [name, source])],
						"max-w-0 w-full",
						titled,
					),
				]
			: [
					truncatedTableCell(h, [name], "max-w-0 w-2/5", titled),
					truncatedTableCell(h, [source], "max-w-0 w-2/5"),
				]),
		numericTableCell(h, [formatProfileValue(row.self, options.unit)], "whitespace-nowrap"),
		...(options.compact === true
			? []
			: [numericTableCell(h, [share(row.self, total)], "whitespace-nowrap")]),
		numericTableCell(h, [formatProfileValue(row.total, options.unit)], "whitespace-nowrap"),
	])
}

/** The functions that used the most themselves, with what they and their callees used in all. */
export const topFunctionsTable = <M>(
	h: HtmlBuilder<M>,
	input: ProfileInput,
	options: FunctionsOptions,
): Html =>
	table(h, { variant: "card", size: "sm", ariaLabel: "Top functions" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Function"]),
				...(options.compact === true ? [] : [tableHead(h, ["Source"])]),
				tableHead(h, ["Self"], "text-right"),
				...(options.compact === true
					? []
					: [tableHead(h, ["Self share"], "text-right whitespace-nowrap")]),
				tableHead(h, ["Total"], "text-right"),
			]),
		]),
		tableBody(
			h,
			Arr.map(topFunctions(scopedStacks(input, options.scope ?? "all"), options.limit), (row) =>
				functionRow(h, row, input.totalValue, options),
			),
		),
	])

export interface ProfileFlamegraphInputs {
	readonly input: ProfileInput
	/** The sample type's unit: `nanoseconds`, `bytes` or `count`. */
	readonly unit: string
	/** Rows of stack shown before the chart scrolls; a narrow panel passes fewer. */
	readonly maxRows?: number
	/** A narrow panel: fewer key hints. */
	readonly isCompact?: boolean
}

/** Header with scope, search and reset; the chart; the selected frame; the key hints. */
export const view = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	inputs: ProfileFlamegraphInputs,
	toMessage: (message: Message) => M,
): Html => {
	if (inputs.input.stacks.length === 0)
		return emptyMessage(h, { dashed: true }, ["No profile samples in this window"])
	const root = profileTree(scopedStacks(inputs.input, model.scope))
	const selected = Option.flatMap(model.selectedNodeId, (id) =>
		Option.fromUndefinedOr(layoutFlame(root).byId.get(id)),
	)
	const revision = publishFlameProps(model.id, {
		root,
		// A refetch rebuilds the tree: the chart keeps its zoom while this stays the same.
		viewKey: `${model.id}:${model.scope}`,
		search: model.search,
		selectedId: Option.getOrNull(Option.map(selected, (frame) => frame.node.id)),
		resetToken: model.resetToken,
		formatValue: (value) => formatProfileValue(value, inputs.unit),
	})
	return h.div(
		[h.Class("border"), h.DataAttribute("profile-flamegraph", model.id)],
		[
			header(h, model, root, inputs.unit, toMessage),
			// The canvas chart builds itself inside this element and follows the revision attribute.
			h.keyed("div")(
				model.id,
				[
					h.Class(
						"relative font-mono outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
					),
					h.Attribute(FLAME_REVISION_ATTRIBUTE, revision),
					// It takes focus and its own keys, which is what an application is; the picture
					// inside is the canvas, named by the chart.
					h.Role("application"),
					h.AriaLabel(
						"Flame chart navigation. Arrow keys move between frames, Enter zooms to the selected frame, W and S zoom, A and D pan, Escape resets the zoom and then clears the selection.",
					),
					h.OnMount(
						Mount.mapMessage(
							MountFlameChart({
								chartId: model.id,
								maxRows: inputs.maxRows ?? DEFAULT_MAX_ROWS,
							}),
							toMessage,
						),
					),
				],
				[],
			),
			...Option.match(selected, {
				onNone: () => [],
				onSome: (frame) => [selection(h, frame, root, inputs.unit)],
			}),
			footer(h, inputs.input.stacks.length, inputs.isCompact ?? false),
		],
	)
}
