import { GROUP_BY_OPTIONS } from "@maple/query-engine/query-builder"
import type { WhereClauseAutocompleteValues } from "../../../lib/query-builder/where-clause-autocomplete"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Combobox from "@maple/views/ui/combobox"
import { chipsView } from "@maple/views/ui/combobox-view"
import { filterChip } from "@maple/views/ui/filter-chip"
import { input } from "@maple/views/ui/input"
import type { AddOnKey } from "./change"
import { groupBySelectionOf, type QueryDraft } from "./draft"
import { Message, type Model } from "./panel"
import { whereEditor } from "./where-editor"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { conditionBuilder } from "./condition-builder-view"
import { conditionRowsOf, whereModeOf } from "./conditions"
import type { WhereMode } from "./panel-message"
import { whereSpecOf, whereTextareaId } from "./where"
import { panelSelect } from "./panel-select"
import { Array as Arr, Record as Rec, Option } from "effect"

// The pieces of a `QueryPanel` body: the where clause, the add-on toggles and their sections.

type H = HtmlBuilder<Message>

export const ADD_ON_KEYS: ReadonlyArray<{ key: AddOnKey; label: string }> = [
	{ key: "groupBy", label: "Group by" },
	{ key: "having", label: "Having" },
	{ key: "orderBy", label: "Order by" },
	{ key: "limit", label: "Limit" },
	{ key: "legend", label: "Legend" },
]

const WHERE_PLACEHOLDER = {
	traces: 'service.name = "checkout" AND status.code = "Error"',
	logs: 'service.name = "checkout" AND severity = "ERROR"',
	metrics: 'service.name = "checkout"',
	product_events: 'event.name = "signup_completed" AND country = "DE"',
}

const WHERE_TEXTAREA_CLASS = "min-h-[32px] resize-y text-xs"

/** The text editor: the textarea under its highlight overlay, and its suggestion list. */
const whereTextEditor = (
	h: H,
	model: Model,
	query: QueryDraft,
	values: WhereClauseAutocompleteValues,
	placeholder: string | undefined,
): Html =>
	whereEditor(h, {
		id: whereTextareaId(query.id),
		value: query.whereClause,
		ariaLabel: `Where clause for query ${query.name}`,
		placeholder: placeholder ?? WHERE_PLACEHOLDER[query.dataSource],
		rows: 1,
		className: "w-full",
		textareaClassName: WHERE_TEXTAREA_CLASS,
		onInput: (value) => Message.ChangedText({ queryId: query.id, field: "whereClause", value }),
		autocomplete: {
			fields: model.whereFields,
			fieldId: query.id,
			// The view reads no key values: only `update` plans their reads.
			spec: whereSpecOf(query, values, null),
			toMessage: (message) => Message.GotWhereField({ message }),
		},
	})

const UNPARSEABLE_NOTE = "This filter uses syntax the builder can't show, edit as text"

/**
 * `WhereClauseEditor`: condition rows when the clause reads as rows (the default), else the text
 * editor, under a Builder/Text switch. Both edit the same where-clause string.
 */
export const whereClauseEditor = (
	h: H,
	model: Model,
	query: QueryDraft,
	values: WhereClauseAutocompleteValues,
	options: Readonly<{ placeholder?: string; className?: string }> = {},
): Html => {
	const rows = conditionRowsOf(model, query)
	const isBuilder = whereModeOf(model, query) === "builder" && Option.isSome(rows)
	const toggle = segmentedSelect(h, {
		options: [
			{ value: "builder", label: "Builder", isDisabled: Option.isNone(rows) },
			{ value: "text", label: "Text" },
		],
		value: isBuilder ? "builder" : "text",
		onChange: (mode: WhereMode) => Message.ChangedWhereMode({ queryId: query.id, mode }),
		size: "xs",
		ariaLabel: `Where clause editor for query ${query.name}`,
		className: "ml-auto shrink-0",
	})
	const note = Option.isNone(rows) ? [typography(h, { size: "xs", tone: "muted" }, [UNPARSEABLE_NOTE])] : []
	const addCondition = button(
		h,
		{
			variant: "ghost",
			size: "xs",
			className: "self-start text-muted-foreground",
			attributes: [h.OnClick(Message.ClickedAddCondition({ queryId: query.id }))],
		},
		[icon(h, "PlusIcon"), "Add condition"],
	)
	return vstack(h, { gap: "1.5", className: options.className ?? "flex-1 min-w-0" }, [
		hstack(h, { gap: "2" }, [...note, toggle]),
		...(isBuilder
			? [
					...conditionBuilder(
						h,
						model,
						query,
						Option.getOrElse(rows, () => []),
						values,
					),
					addCondition,
				]
			: [whereTextEditor(h, model, query, values, options.placeholder)]),
	])
}

/** A controlled `<Input>` that reports each keystroke. */
export const textInput = <M>(
	h: HtmlBuilder<M>,
	id: string,
	value: string,
	placeholder: string,
	className: string,
	toMessage: (value: string) => M,
	type?: string,
): Html =>
	input(h, {
		id,
		className,
		...(type === undefined ? undefined : { type }),
		attributes: [h.Value(value), h.Placeholder(placeholder), h.OnInput(toMessage)],
	})

/** `AddOnToggleBar`. */
export const addOnToggles = (
	h: H,
	query: QueryDraft,
	keys: ReadonlyArray<{ key: AddOnKey; label: string }>,
): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-1.5 pt-1 border-t border-dashed")],
		Arr.map(keys, ({ key, label }) =>
			filterChip(
				h,
				{
					size: "xs",
					isPressed: query.addOns[key],
					onClick: Message.ToggledAddOn({ queryId: query.id, key }),
				},
				[label],
			),
		),
	)

const sectionLabel = (h: H, text: string): Html =>
	h.span([h.Class("text-2xs text-muted-foreground w-16 shrink-0")], [text])

/** `GroupByMultiSelect`: the source's built-in dimensions as chips. TODO(widget-editor): `attr.*` keys. */
const groupBySelect = (h: H, model: Model, query: QueryDraft): Html => {
	const current = model.groupBys[query.id] ?? Combobox.init(`group-by-${query.id}`, "multiple")
	return h.submodel({
		slotId: `${model.slotPrefix}-group-by-${query.id}`,
		model: { ...current, selected: [...groupBySelectionOf(query)] },
		view: chipsView,
		toParentMessage: (message) => Message.GotGroupByMessage({ queryId: query.id, message }),
		viewInputs: {
			items: Arr.map(
				Arr.filter(GROUP_BY_OPTIONS[query.dataSource], (option) => option.value !== "none"),
				(option) => option.value,
			),
			placeholder: groupBySelectionOf(query).length === 0 ? "service.name" : "",
			emptyText: "No fields match",
			className: "text-xs font-mono",
			toView: (parts) => h.div([h.Class("flex-1 min-w-[140px]")], parts),
		},
	})
}

const row = (h: H, label: string, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("flex items-center gap-2")], [sectionLabel(h, label), ...children])

/** `AddOnSections`: the inputs each enabled add-on reveals. */
export const addOnSections = (h: H, model: Model, query: QueryDraft): ReadonlyArray<Html> => {
	if (!Arr.some(Rec.values(query.addOns), Boolean)) return []
	const text = (field: "having" | "orderBy" | "limit" | "legend") => (value: string) =>
		Message.ChangedText({ queryId: query.id, field, value })
	return [
		h.div(
			[h.Class("space-y-2 pt-1")],
			[
				...(query.addOns.groupBy && query.dataSource !== "metrics"
					? [row(h, "Group By", [groupBySelect(h, model, query)])]
					: []),
				...(query.addOns.having
					? [
							row(h, "Having", [
								textInput(
									h,
									`having-${query.id}`,
									query.having,
									"count > 10",
									"h-8 text-xs flex-1",
									text("having"),
								),
							]),
						]
					: []),
				...(query.addOns.orderBy
					? [
							panelSelect(
								h,
								model,
								`orderDirection:${query.id}`,
								query.orderByDirection,
								[
									{ value: "desc", label: "desc" },
									{ value: "asc", label: "asc" },
								],
								{
									size: "sm",
									className: "w-20",
									toView: (parts) =>
										row(h, "Order By", [
											textInput(
												h,
												`order-by-${query.id}`,
												query.orderBy,
												"value",
												"h-8 text-xs flex-1",
												text("orderBy"),
											),
											...parts,
										]),
								},
							),
						]
					: []),
				...(query.addOns.limit
					? [
							row(h, "Limit", [
								textInput(
									h,
									`limit-${query.id}`,
									query.limit,
									"10",
									"h-8 w-24 text-xs",
									text("limit"),
									"number",
								),
							]),
						]
					: []),
				...(query.addOns.legend
					? [
							row(h, "Legend", [
								textInput(
									h,
									`legend-${query.id}`,
									query.legend,
									"Human-friendly series name",
									"h-8 text-xs flex-1",
									text("legend"),
								),
							]),
						]
					: []),
			],
		),
	]
}
