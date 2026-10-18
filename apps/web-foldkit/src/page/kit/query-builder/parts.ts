import { GROUP_BY_OPTIONS } from "@maple/query-engine/query-builder"
import { cn } from "@maple/ui/lib/utils"
import {
	tokenizeWhereClause,
	WHERE_CLAUSE_TOKEN_COLOR,
} from "@maple/web/lib/query-builder/where-clause-highlight"
import type { WhereClauseAutocompleteValues } from "@maple/web/lib/query-builder/where-clause-autocomplete"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Combobox from "../../../ui/combobox"
import { chipsView } from "../../../ui/combobox-view"
import { filterChip } from "../../../ui/filter-chip"
import { input } from "../../../ui/input"
import * as Select from "../../../ui/select"
import { view as selectView, type SelectOption } from "../../../ui/select-view"
import { textarea } from "../../../ui/textarea"
import type { AddOnKey } from "./change"
import type { QueryDraft } from "./draft"
import { Message, type Model } from "./panel"
import { MountWhereCaret, MountWhereListbox } from "./where-command"
import { caretOf, whereAutocompleteOf, whereTextareaId } from "./where"
import { isOpenOf } from "../where-autocomplete"
import { suggestionListbox, whereKeyHandler } from "../where-autocomplete-view"

// The pieces of a `QueryPanel` body: the where clause, the add-on toggles and their sections.

type H = HtmlBuilder<Message>

export const ADD_ON_KEYS: ReadonlyArray<{ key: AddOnKey; label: string }> = [
	{ key: "groupBy", label: "Group by" },
	{ key: "having", label: "Having" },
	{ key: "orderBy", label: "Order by" },
	{ key: "limit", label: "Limit" },
	{ key: "legend", label: "Legend" },
]

/** One of the panel's selects, kept by id; its value is always the draft's. */
export const panelSelect = (
	h: H,
	model: Model,
	id: string,
	value: string,
	options: ReadonlyArray<SelectOption>,
	inputs: Readonly<{
		size?: "sm" | "default"
		className?: string
		ariaLabel?: string
		/** Places the trigger and its siblings (hidden input, portal) in the caller's layout. */
		toView: (parts: ReadonlyArray<Html>) => Html
	}>,
): Html => {
	const index = options.findIndex((option) => option.value === value)
	const current =
		model.selects[id] ?? Select.init(id, { value, selectedIndex: index === -1 ? null : index })
	return h.submodel({
		slotId: `${model.slotPrefix}-select-${id}`,
		model: { ...current, value },
		view: selectView,
		toParentMessage: (message) => Message.GotSelectMessage({ id, message }),
		viewInputs: {
			entries: options.map((item) => ({ _tag: "Item" as const, item })),
			size: inputs.size,
			className: inputs.className,
			ariaLabel: inputs.ariaLabel,
			toView: inputs.toView,
		},
	})
}

const WHERE_PLACEHOLDER = {
	traces: 'service.name = "checkout" AND status.code = "Error"',
	logs: 'service.name = "checkout" AND severity = "ERROR"',
	metrics: 'service.name = "checkout"',
	product_events: 'event.name = "signup_completed" AND country = "DE"',
}

const WHERE_TEXTAREA_CLASS = "min-h-[32px] resize-y text-xs"

/** `WhereClauseEditor`: the textarea under its highlight overlay, and its suggestion list. */
export const whereClauseEditor = (
	h: H,
	model: Model,
	query: QueryDraft,
	values: WhereClauseAutocompleteValues,
	options: Readonly<{ placeholder?: string; className?: string }> = {},
): Html => {
	const caret = caretOf(model, query)
	const autocomplete = whereAutocompleteOf(model, query, values)
	const isOpen = isOpenOf(caret, autocomplete)
	return h.div(
		[h.Class(options.className ?? "relative flex-1")],
		[
			textarea(h, {
				id: whereTextareaId(query.id),
				className: cn(WHERE_TEXTAREA_CLASS, query.whereClause.length > 0 && "text-transparent caret-foreground"),
				defaultValue: query.whereClause,
				attributes: [
					h.AriaLabel(`Where clause for query ${query.name}`),
					h.Placeholder(options.placeholder ?? WHERE_PLACEHOLDER[query.dataSource]),
					h.Rows(1),
					h.OnInput((value) => Message.ChangedText({ queryId: query.id, field: "whereClause", value })),
					h.OnKeyDownPreventDefault(
						whereKeyHandler<Message>(isOpen, {
							enter: Message.PressedWhereEnter({ queryId: query.id }),
							move: (step) => Message.MovedWhereSuggestion({ queryId: query.id, step }),
							tab: Message.PressedWhereTab({ queryId: query.id }),
							dismiss: Message.DismissedWhereSuggestions({ queryId: query.id }),
						}),
					),
					h.OnMount(MountWhereCaret({ queryId: query.id })),
				],
			}),
			...highlightOverlay(h, query.whereClause, WHERE_TEXTAREA_CLASS),
			...(isOpen
				? [
						suggestionListbox(h, {
							suggestions: autocomplete.suggestions,
							activeIndex: caret.activeIndex,
							anchor: caret.anchor,
							onApply: (index) => Message.AppliedWhereSuggestion({ queryId: query.id, index }),
							keepFocus: h.OnMount(MountWhereListbox({ queryId: query.id })),
						}),
					]
				: []),
		],
	)
}

export type WhereClauseFieldOptions<M> = Readonly<{
	query: QueryDraft
	/** `WhereClauseEditor`'s `className` (its root) and `textareaClassName` (textarea and overlay). */
	className: string
	textareaClassName: string
	placeholder: string
	rows: number
	onInput: (value: string) => M
	onEnter: M
}>

/** `WhereClauseEditor` without suggestions, for any host Message. */
export const whereClauseField = <M>(h: HtmlBuilder<M>, options: WhereClauseFieldOptions<M>): Html => {
	const { query, textareaClassName } = options
	return h.div(
		[h.Class(options.className)],
		[
			textarea(h, {
				id: whereTextareaId(query.id),
				className: cn(textareaClassName, query.whereClause.length > 0 && "text-transparent caret-foreground"),
				defaultValue: query.whereClause,
				attributes: [
					h.AriaLabel(`Where clause for query ${query.name}`),
					h.Placeholder(options.placeholder),
					h.Rows(options.rows),
					h.OnInput(options.onInput),
					// Where clauses are single-line.
					h.OnKeyDownPreventDefault((key) =>
						key === "Enter" ? Option.some(options.onEnter) : Option.none(),
					),
				],
			}),
			...highlightOverlay(h, query.whereClause, textareaClassName),
		],
	)
}

/** The colored tokens drawn over a transparent textarea, matching its box. */
const highlightOverlay = <M>(h: HtmlBuilder<M>, whereClause: string, textareaClassName: string): ReadonlyArray<Html> =>
	whereClause.length === 0
		? []
		: [
				h.div(
					[
						h.AriaHidden(true),
						h.Class(
							cn(
								"pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent text-base sm:text-sm",
								textareaClassName,
							),
						),
					],
					[
						h.div(
							[h.Class("px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] break-words whitespace-pre-wrap")],
							tokenizeWhereClause(whereClause).map((token) =>
								h.span([h.Style({ color: WHERE_CLAUSE_TOKEN_COLOR[token.type] })], [token.text]),
							),
						),
					],
				),
			]

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
		slotId: `${model.slotPrefix}-group-by-${query.id}`,
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
