import { GROUP_BY_OPTIONS } from "@maple/query-engine/query-builder"
import { cn } from "@maple/ui/lib/utils"
import {
	tokenizeWhereClause,
	WHERE_CLAUSE_TOKEN_COLOR,
} from "@maple/web/lib/query-builder/where-clause-highlight"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Combobox from "../../../ui/combobox"
import { chipsView } from "../../../ui/combobox-view"
import { filterChip } from "../../../ui/filter-chip"
import { input } from "../../../ui/input"
import { textarea } from "../../../ui/textarea"
import type { QueryDraft } from "./editor-state"
import { type AddOnKey, Message } from "./message"
import type { Model } from "./model"
import { pageSelect } from "./view-select"

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

/**
 * `WhereClauseEditor`: the textarea under its highlight overlay.
 * TODO(widget-editor): the autocomplete listbox (`useWhereClauseAutocomplete`).
 */
export const whereClauseEditor = (h: H, query: QueryDraft): Html => {
	const isHighlighting = query.whereClause.length > 0
	return h.div(
		[h.Class("relative flex-1")],
		[
			textarea(h, {
				id: `where-${query.id}`,
				className: cn(WHERE_TEXTAREA_CLASS, isHighlighting && "text-transparent caret-foreground"),
				defaultValue: query.whereClause,
				attributes: [
					h.AriaLabel(`Where clause for query ${query.name}`),
					h.Placeholder(WHERE_PLACEHOLDER[query.dataSource]),
					h.Rows(1),
					h.OnInput((value) =>
						Message.ChangedQueryText({ queryId: query.id, field: "whereClause", value }),
					),
					// Where clauses are single-line.
					h.OnKeyDownPreventDefault((key) =>
						key === "Enter" ? Option.some(Message.ClickedRunPreview()) : Option.none(),
					),
				],
			}),
			...(isHighlighting
				? [
						h.div(
							[
								h.AriaHidden(true),
								h.Class(
									cn(
										"pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent text-base sm:text-sm",
										WHERE_TEXTAREA_CLASS,
									),
								),
							],
							[
								h.div(
									[
										h.Class(
											"px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] break-words whitespace-pre-wrap",
										),
									],
									tokenizeWhereClause(query.whereClause).map((token) =>
										h.span(
											[h.Style({ color: WHERE_CLAUSE_TOKEN_COLOR[token.type] })],
											[token.text],
										),
									),
								),
							],
						),
					]
				: []),
		],
	)
}

/** A controlled `<Input>` that reports each keystroke. */
export const textInput = (
	h: H,
	id: string,
	value: string,
	placeholder: string,
	className: string,
	toMessage: (value: string) => Message,
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
		keys.map(({ key, label }) =>
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
		slotId: `widget-editor-group-by-${query.id}`,
		model: { ...current, selected: query.groupBy },
		view: chipsView,
		toParentMessage: (message) => Message.GotGroupByMessage({ queryId: query.id, message }),
		viewInputs: {
			items: GROUP_BY_OPTIONS[query.dataSource]
				.filter((option) => option.value !== "none")
				.map((option) => option.value),
			placeholder: query.groupBy.length === 0 ? "service.name" : "",
			emptyText: "No fields found.",
			className: "text-xs font-mono",
			toView: (parts) => h.div([h.Class("flex-1 min-w-[140px]")], parts),
		},
	})
}

const row = (h: H, label: string, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("flex items-center gap-2")], [sectionLabel(h, label), ...children])

/** `AddOnSections`: the inputs each enabled add-on reveals. */
export const addOnSections = (h: H, model: Model, query: QueryDraft): ReadonlyArray<Html> => {
	if (!Object.values(query.addOns).some(Boolean)) return []
	const text = (field: "having" | "orderBy" | "limit" | "legend") => (value: string) =>
		Message.ChangedQueryText({ queryId: query.id, field, value })
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
							pageSelect(
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
