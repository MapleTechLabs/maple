import type { WhereClauseAutocompleteValues } from "../../../lib/query-builder/where-clause-autocomplete"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Combobox from "@maple/views/ui/combobox"
import { comboboxPicker } from "@maple/views/ui/combobox-picker"
import { chipsView, view as comboboxView } from "@maple/views/ui/combobox-view"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import {
	type ConditionField,
	type FieldPickerItem,
	fieldOf,
	fieldPickerItems,
	fieldsOf,
	groupLabelOf,
	isOwnedElsewhere,
	OPERATOR_LABEL,
	operatorsOf,
	sharesLabel,
	valueSuggestionsOf,
} from "./condition-fields"
import { type ConditionRow, isUnspellable, isValueless } from "./condition-rows"
import { conditionPickerId, operatorSelectId, valuePickerOf } from "./conditions"
import type { QueryDraft } from "./draft"
import { Message, type Model } from "./panel-message"
import { panelSelect } from "./panel-select"
import { Array as Arr, Option, String as Str } from "effect"

// `ConditionBuilder`: the where clause as `[field] [operator] [values]` rows, AND-ed, each
// picked from the query's own vocabulary.

type H = HtmlBuilder<Message>

const GROUP_SHORT = { common: "", resource: "resource", attribute: "attr" }

/** The pick as the list shows it: no `attr.` / `resource.` prefix, the group named only to tell two fields apart. */
const fieldTrigger = (h: H, field: ConditionField, isLabelShared: boolean): ReadonlyArray<Html | string> =>
	isLabelShared && field.group !== "common"
		? [
				field.label,
				typography(h, { size: "2xs", tone: "subtle", as: "span", className: "ml-1.5" }, [
					GROUP_SHORT[field.group],
				]),
			]
		: [field.label]

const fieldItem = (
	h: HtmlBuilder<Combobox.Message>,
	item: FieldPickerItem,
	dataSource: QueryDraft["dataSource"],
	isSearching: boolean,
): ReadonlyArray<Html | string> => {
	const row = (label: string, trailing: ReadonlyArray<Html>) =>
		hstack(h, { gap: "2", justify: "between", shrink: true, className: "w-full" }, [
			typography(h, { truncate: true, as: "span" }, [label]),
			...trailing,
		])
	const hint = (text: string) =>
		typography(
			h,
			{ size: "2xs", tone: "subtle", mono: true, as: "span", truncate: true, className: "max-w-1/2" },
			[text],
		)
	switch (item._tag) {
		case "Field":
			return [
				row(item.field.label, [
					...(item.field.group === "common"
						? [hint(item.field.key)]
						: isSearching
							? [hint(GROUP_SHORT[item.field.group])]
							: []),
				]),
			]
		case "Group":
			return [
				row(groupLabelOf(item.group, dataSource), [
					hstack(h, { gap: "1", as: "span" }, [
						hint(String(item.count)),
						icon(h, "ChevronRightIcon", { size: 12, className: "text-foreground-subtle" }),
					]),
				]),
			]
		case "Back":
			return [
				hstack(h, { gap: "1.5", as: "span" }, [
					icon(h, "ChevronLeftIcon", { size: 12, className: "text-foreground-subtle" }),
					"All fields",
				]),
			]
		case "Custom":
			return [row(`Use "${item.key}"`, [])]
	}
}

const fieldPicker = (
	h: H,
	model: Model,
	query: QueryDraft,
	row: ConditionRow,
	index: number,
	values: WhereClauseAutocompleteValues,
	rowFields: ReadonlyArray<ConditionField>,
): Html => {
	const id = conditionPickerId(query.id, row.id, "field")
	const picker = model.conditionPickers[id] ?? Combobox.init(id, "single")
	const current = { ...picker, selected: row.key === "" ? [] : [row.key] }
	const search = Combobox.queryOf(current)
	const fields = fieldsOf(query.dataSource, values)
	const field = fieldOf(row.key, query.dataSource)
	const items = fieldPickerItems(fields, model.fieldDrills[id] ?? "all", search, query.dataSource)
	const byValue = new Map(Arr.map(items, (item) => [item.value, item]))
	const firstGroup = Option.getOrNull(Arr.findFirst(items, (item) => item._tag === "Group"))
	return h.submodel({
		slotId: `${model.slotPrefix}-${id}`,
		model: current,
		view: comboboxPicker,
		toParentMessage: (message) =>
			Message.GotConditionField({ queryId: query.id, rowId: row.id, message }),
		viewInputs: {
			items: Arr.map(items, (item) => item.value),
			// The label replaces the trigger's text for screen readers, so it carries the pick.
			ariaLabel:
				row.key === ""
					? `Field for condition ${index + 1}`
					: `Field for condition ${index + 1}: ${row.key}`,
			searchPlaceholder: "Search fields…",
			emptyText: "No fields match",
			trigger:
				row.key === ""
					? ["Choose field"]
					: fieldTrigger(h, field, sharesLabel(field, [...fields, ...rowFields])),
			isPlaceholder: row.key === "",
			...(row.key === "" ? undefined : { tooltip: row.key }),
			triggerClassName: "w-full max-w-80",
			renderItem: (itemH, value) => {
				const item = byValue.get(value)
				return item === undefined
					? [value]
					: fieldItem(itemH, item, query.dataSource, Str.trim(search) !== "")
			},
			itemClassName: (value) =>
				firstGroup !== null && value === firstGroup.value
					? "mt-1 border-t border-border-subtle pt-1"
					: undefined,
			toView: (parts) => h.div([h.Class(FIELD_CELL)], parts),
		},
	})
}

/** A row's field in words, for the labels of its controls. */
const rowFieldLabel = (row: ConditionRow, dataSource: QueryDraft["dataSource"]): string =>
	row.key === "" ? "new condition" : fieldOf(row.key, dataSource).label

/** "Service is checkout, api", or just "Service" before a value is picked: what a row's remove button removes. */
const rowSummary = (row: ConditionRow, dataSource: QueryDraft["dataSource"]): string =>
	row.key === ""
		? "new condition"
		: Arr.join(
				[
					rowFieldLabel(row, dataSource),
					...(isValueless(row.operator) || row.values.length > 0
						? [OPERATOR_LABEL[row.operator]]
						: []),
					...(row.values.length === 0 ? [] : [Arr.join(row.values, ", ")]),
				],
				" ",
			)

const UNSPELLABLE_NOTE = `A value can't hold both ' and "`

const valuePicker = (
	h: H,
	model: Model,
	query: QueryDraft,
	row: ConditionRow,
	values: WhereClauseAutocompleteValues,
): ReadonlyArray<Html> => {
	const id = conditionPickerId(query.id, row.id, "values")
	const picker = valuePickerOf(model, query, row)
	const suggestions = valueSuggestionsOf(fieldOf(row.key, query.dataSource), query.dataSource, values)
	const typed = Str.trim(Combobox.queryOf(picker))
	const isUnspellableTyped = isUnspellable(typed)
	// What is typed is offered first when it is not already a suggestion, so a click adds it too.
	const isTypedNew =
		typed !== "" && !isUnspellableTyped && !suggestions.includes(typed) && !row.values.includes(typed)
	const items = isTypedNew ? [typed, ...suggestions] : suggestions
	const ariaLabel = `Value for ${rowFieldLabel(row, query.dataSource)}`
	const toMessage = (message: Combobox.Message) =>
		Message.GotConditionValues({ queryId: query.id, rowId: row.id, message })
	const renderItem = (value: string): ReadonlyArray<Html | string> =>
		isTypedNew && value === typed ? [`Use "${value}"`] : [value]
	const note = isUnspellableTyped
		? [typography(h, { size: "2xs", tone: "warning", as: "p" }, [UNSPELLABLE_NOTE])]
		: []
	const field =
		picker.mode === "multiple"
			? h.submodel({
					slotId: `${model.slotPrefix}-${id}`,
					model: picker,
					view: chipsView,
					toParentMessage: toMessage,
					viewInputs: {
						items,
						ariaLabel,
						placeholder: row.values.length === 0 ? "Value" : "",
						emptyText: "Type a value and press Enter",
						size: "sm",
						renderItem: (_, value) => renderItem(value),
						toView: (parts) => h.div([h.Class("min-w-0")], parts),
					},
				})
			: h.submodel({
					slotId: `${model.slotPrefix}-${id}`,
					model: picker,
					view: comboboxView,
					toParentMessage: toMessage,
					viewInputs: {
						items,
						ariaLabel,
						placeholder: "Value",
						emptyText: "Type a value and press Enter",
						size: "sm",
						highlightsSelected: true,
						renderItem,
						toView: ({ field: input, rest }) => h.div([h.Class("min-w-0")], [input, ...rest]),
					},
				})
	return [field, ...note]
}

// Wide (the where area, `@container/where`): one line of [lead] [field] [operator] [values]
// [remove], the field and operator as wide as their text. Narrow: the lead, field and remove on
// one line, then the operator and values under the field. `min-w` is what a row needs beside the
// editor's floated controls; with less it drops under them.
const ROW_GRID =
	"grid min-w-52 grid-cols-[2.5rem_max-content_minmax(0,1fr)_auto] items-center gap-1.5 @xl/where:min-w-108 @xl/where:grid-cols-[2.5rem_minmax(8rem,max-content)_max-content_minmax(10rem,1fr)_auto]"
const FIELD_CELL = "col-span-2 col-start-2 row-start-1 min-w-32 @xl/where:col-span-1"
const OPERATOR_CELL = "col-start-2 row-start-2 @xl/where:col-start-3 @xl/where:row-start-1"
const VALUES_CELL =
	"col-span-2 col-start-3 row-start-2 min-w-0 @xl/where:col-span-1 @xl/where:col-start-4 @xl/where:row-start-1"
const REMOVE_CELL = "col-start-4 row-start-1 @xl/where:col-start-5"

const conditionRow = (
	h: H,
	model: Model,
	query: QueryDraft,
	row: ConditionRow,
	index: number,
	values: WhereClauseAutocompleteValues,
	rowFields: ReadonlyArray<ConditionField>,
): Html => {
	const connector = typography(h, { size: "xs", tone: "muted", className: "col-start-1 row-start-1" }, [
		index === 0 ? "Where" : "and",
	])
	const remove = iconButton(
		h,
		{
			size: "icon-xs",
			label: `Remove condition: ${rowSummary(row, query.dataSource)}`,
			hasTooltip: false,
			className: cn(REMOVE_CELL, "text-muted-foreground hover:text-foreground active:text-foreground"),
			attributes: [h.OnClick(Message.ClickedRemoveCondition({ queryId: query.id, rowId: row.id }))],
		},
		[icon(h, "XmarkIcon")],
	)
	const field = fieldPicker(h, model, query, row, index, values, rowFields)
	const layout = (parts: ReadonlyArray<Html>) =>
		h.div(
			[h.Class(ROW_GRID), h.DataAttribute("slot", "condition-row")],
			[connector, field, ...parts, remove],
		)
	if (row.key === "") return layout([])
	const fieldLabel = rowFieldLabel(row, query.dataSource)
	return panelSelect(
		h,
		model,
		operatorSelectId(query.id, row.id),
		row.operator,
		Arr.map(
			operatorsOf(fieldOf(row.key, query.dataSource), query.dataSource, row.operator),
			(operator) => ({
				value: operator,
				label: OPERATOR_LABEL[operator],
			}),
		),
		{
			size: "sm",
			// As wide as the operator's words, not the select's default 9rem.
			className: cn(OPERATOR_CELL, "min-w-16"),
			// The label replaces the trigger's text for screen readers, so it carries the pick.
			ariaLabel: `Operator for ${fieldLabel}: ${OPERATOR_LABEL[row.operator]}`,
			alignItemWithTrigger: false,
			toView: (parts) =>
				layout([
					...parts,
					...(isValueless(row.operator)
						? []
						: [
								vstack(
									h,
									{ gap: "1", className: VALUES_CELL },
									valuePicker(h, model, query, row, values),
								),
							]),
				]),
		},
	)
}

/** The rows a query shows, or nothing: the caller's "Add condition" starts the first. A row another
 * control owns (traces `root_only`) stays in the clause but is not drawn. */
export const conditionBuilder = (
	h: H,
	model: Model,
	query: QueryDraft,
	rows: ReadonlyArray<ConditionRow>,
	values: WhereClauseAutocompleteValues,
): ReadonlyArray<Html> => {
	const shown = Arr.filter(rows, (row) => !isOwnedElsewhere(row.key, query.dataSource))
	const rowFields = Arr.map(
		Arr.filter(shown, (row) => row.key !== ""),
		(row) => fieldOf(row.key, query.dataSource),
	)
	// A plain block, not a stack: each row lays out against the editor's floated controls itself.
	return shown.length === 0
		? []
		: [
				h.div(
					[
						h.AriaLabel(`Conditions for query ${query.name}`),
						h.Class("space-y-1.5"),
						h.Role("group"),
					],
					Arr.map(shown, (row, index) =>
						conditionRow(h, model, query, row, index, values, rowFields),
					),
				),
			]
}
