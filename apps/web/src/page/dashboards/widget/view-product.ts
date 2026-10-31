import { queryBadgeColor } from "@maple/query-engine/query-builder"
import { FUNNEL_SESSION_DIMENSION_LABEL, QUERY_BUILDER_DATA_SOURCES } from "@maple/query-model"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import {
	FUNNEL_KEY_BY_OPTIONS,
	FUNNEL_SESSION_DIMENSIONS,
	FUNNEL_WINDOW_OPTIONS,
} from "../../../components/funnels/definition"
import { parseProductEventsFilterClause } from "../../../lib/query-builder/funnel-filters"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { filterChip } from "../../../ui/filter-chip"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { input } from "../../../ui/input"
import type { SelectOption } from "../../../ui/select-view"
import { whereEditor } from "../../kit/query-builder/where-editor"
import { autocompleteFor, populationField } from "./where-fields"
import { Message } from "./message"
import type { Model } from "./model"
import { ProductEdit, type StepScope } from "./product-edit"
import {
	BREAKDOWN_ATTRIBUTE,
	BREAKDOWN_NONE,
	BREAKDOWN_SELECT_ID,
	keyBySelectId,
	windowSelectId,
} from "./product-selects"
import { pageSelect } from "./view-select"

// `QueryPanelShell` and `AddOnToggleBar`, and the rows the funnel and
// paths panels share: the population filter, Count by, the window, the breakdown.

type H = HtmlBuilder<Message>

export const product = (edit: ProductEdit): Message => Message.ChangedProduct({ edit })

const SOURCE_LABEL = {
	traces: "Traces",
	logs: "Logs",
	metrics: "Metrics",
	product_events: "Product events",
} as const

/** `QueryPanelShell` for query A on Product events; `sourceId` is its source select. */
export const panelShell = (
	h: H,
	model: Model,
	sourceId: string,
	sources: ReadonlyArray<keyof typeof SOURCE_LABEL>,
	children: ReadonlyArray<Html>,
): Html => {
	const isCollapsed = model.isProductPanelCollapsed
	return h.div(
		[h.Class("border rounded-md")],
		[
			pageSelect(
				h,
				model,
				sourceId,
				"product_events",
				sources.map((value) => ({ value, label: SOURCE_LABEL[value] })),
				{
					size: "sm",
					className: "w-36 border-none bg-transparent shadow-none px-1",
					ariaLabel: "Query source",
					toView: (parts) =>
						h.div(
							[h.Class("flex items-center gap-2 px-3 py-2 bg-surface-sunken")],
							[
								iconButton(
									h,
									{
										size: "icon-xs",
										label: isCollapsed ? "Expand query" : "Collapse query",
										hasTooltip: false,
										className: "text-muted-foreground hover:text-foreground active:text-foreground",
										attributes: [h.OnClick(Message.ToggledProductPanel())],
									},
									[icon(h, isCollapsed ? "ChevronRightIcon" : "ChevronDownIcon")],
								),
								h.span(
									[
										h.Class(
											cn(
												badgeVariants({
													variant: "outline",
													className: cn(
														"font-mono text-2xs text-white border-0 shrink-0",
														queryBadgeColor(0),
													),
												}),
											),
										),
										h.DataAttribute("slot", "badge"),
									],
									["A"],
								),
								...parts,
								h.div([h.Class("flex-1")], []),
								button(h, { variant: "ghost", size: "xs", isDisabled: true }, ["Remove"]),
							],
						),
				},
			),
			...(isCollapsed ? [] : [h.div([h.Class("p-3 space-y-3")], children)]),
		],
	)
}

export const FUNNEL_SOURCES = QUERY_BUILDER_DATA_SOURCES

/** `AddOnToggleBar`. */
export const addOnBar = <K extends string>(
	h: H,
	items: ReadonlyArray<{ key: K; label: string }>,
	active: Readonly<Record<K, boolean>>,
	onToggle: (key: K) => Message,
): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-1.5 pt-1 border-t border-dashed")],
		items.map(({ key, label }) =>
			filterChip(h, { size: "xs", isPressed: active[key], onClick: onToggle(key) }, [label]),
		),
	)

export const rowLabel = (
	h: H,
	text: string,
	className = "w-16 shrink-0 text-2xs text-muted-foreground",
): Html => h.span([h.Class(className)], [text])

/** The population filter and its parse error (or what it means). */
export const populationFilter = (
	h: H,
	model: Model,
	scope: StepScope,
	value: string,
	ariaLabel: string,
): Html => {
	const parsed = parseProductEventsFilterClause(value)
	return h.div(
		[h.Class("space-y-1")],
		[
			h.div(
				[h.Class("flex items-start gap-2")],
				[
					rowLabel(h, "Where", "w-16 shrink-0 pt-2 text-2xs text-muted-foreground"),
					whereEditor(h, {
						id: `widget-${scope}-population`,
						value,
						ariaLabel,
						placeholder: 'country = "DE" AND utm.source = "twitter"',
						rows: 1,
						className: "flex-1",
						textareaClassName: "min-h-[32px] resize-y text-xs",
						onInput: (next) =>
							product(ProductEdit.ChangedPopulationFilter({ scope, value: next })),
						autocomplete: autocompleteFor(model, populationField(model, scope, value)),
					}),
				],
			),
			h.p(
				[h.Class("pl-18 text-2xs text-muted-foreground")],
				[
					parsed.ok
						? "Only persons with a session matching these dimensions take part."
						: h.span([h.Class(TONE_TEXT.crit)], [parsed.error]),
				],
			),
		],
	)
}

const row = (h: H, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("flex items-center gap-2")], children)

/** Count by: the four keys, each with what it counts. */
export const keyByRow = (h: H, model: Model, scope: StepScope, value: string): Html =>
	pageSelect(
		h,
		model,
		keyBySelectId(scope),
		value,
		FUNNEL_KEY_BY_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
		{
			size: "sm",
			className: "w-56",
			ariaLabel: "Count by",
			renderItem: (option) => {
				const description =
					FUNNEL_KEY_BY_OPTIONS.find((candidate) => candidate.value === option.value)
						?.description ?? ""
				return [
					h.span(
						[h.Class("flex flex-col")],
						[
							h.span([], [option.label]),
							h.span([h.Class("text-3xs text-muted-foreground")], [description]),
						],
					),
				]
			},
			toView: (parts) => row(h, [rowLabel(h, "Count by"), ...parts]),
		},
	)

/** The window select; a stored window off the list is offered as its seconds. */
export const windowRow = (
	h: H,
	model: Model,
	scope: StepScope,
	seconds: number,
	inputs: Readonly<{ label: string; ariaLabel: string; size?: "sm"; className: string; hint: string }>,
): Html => {
	const options: ReadonlyArray<SelectOption> = [
		...FUNNEL_WINDOW_OPTIONS.map((option) => ({ value: String(option.value), label: option.label })),
		...(FUNNEL_WINDOW_OPTIONS.every((option) => option.value !== seconds)
			? [{ value: String(seconds), label: `${seconds}s` }]
			: []),
	]
	return pageSelect(h, model, windowSelectId(scope), String(seconds), options, {
		...(inputs.size === undefined ? undefined : { size: inputs.size }),
		className: inputs.className,
		ariaLabel: inputs.ariaLabel,
		toView: (parts) =>
			row(h, [
				rowLabel(h, inputs.label),
				...parts,
				h.span([h.Class("text-2xs text-muted-foreground")], [inputs.hint]),
			]),
	})
}

/** `BreakdownPicker`: none, a session dimension, or `attribute:<key>` typed by hand. */
export const breakdownRow = (h: H, model: Model, breakdownBy: string | undefined): Html => {
	const fromValue = breakdownBy !== undefined && breakdownBy.startsWith("attribute:")
	const isAttribute = fromValue || (model.breakdownAttribute.isActive && breakdownBy === undefined)
	const selected = isAttribute ? BREAKDOWN_ATTRIBUTE : (breakdownBy ?? BREAKDOWN_NONE)
	const key = fromValue ? breakdownBy.slice("attribute:".length) : model.breakdownAttribute.key
	return pageSelect(
		h,
		model,
		BREAKDOWN_SELECT_ID,
		selected,
		[
			{ value: BREAKDOWN_NONE, label: "None" },
			...FUNNEL_SESSION_DIMENSIONS.map((dimension) => ({
				value: dimension,
				label: FUNNEL_SESSION_DIMENSION_LABEL[dimension],
			})),
			{ value: BREAKDOWN_ATTRIBUTE, label: "Attribute…" },
		],
		{
			size: "sm",
			className: "w-32 min-w-0",
			ariaLabel: "Break down by",
			toView: (parts) =>
				row(h, [
					rowLabel(h, "Breakdown"),
					h.div(
						[h.Class("flex items-center gap-1.5")],
						[
							...parts,
							...(isAttribute
								? [
										input(h, {
											id: "widget-funnel-breakdown-key",
											size: "sm",
											className: "w-40 font-mono text-xs",
											attributes: [
												h.Value(key),
												h.Placeholder("attribute key, e.g. plan"),
												h.AriaLabel("Breakdown attribute key"),
												h.OnInput((value) =>
													Message.ChangedBreakdownAttribute({ value }),
												),
											],
										}),
									]
								: []),
						],
					),
					h.span([h.Class("text-2xs text-muted-foreground")], ["one bar per group, top 6"]),
				]),
		},
	)
}

/** Run preview under a panel, and the query letter it runs. */
export const runRow = (h: H, error: string | null): Html =>
	h.div(
		[h.Class("flex items-center gap-3")],
		[
			button(
				h,
				{
					size: "sm",
					isDisabled: error !== null,
					attributes: [h.OnClick(Message.ClickedRunPreview())],
				},
				["Run preview"],
			),
			h.span([h.Class("text-2xs text-muted-foreground ml-auto")], ["A"]),
		],
	)
