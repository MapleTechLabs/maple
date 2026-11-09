import type { WhereClauseAutocompleteValues } from "../../../lib/query-builder/where-clause-autocomplete"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Combobox from "@maple/views/ui/combobox"
import { comboboxPicker } from "@maple/views/ui/combobox-picker"
import { chipsView } from "@maple/views/ui/combobox-view"
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
	OPERATOR_LABEL,
	operatorsOf,
	valueSuggestionsOf,
} from "./condition-fields"
import { type ConditionRow, isValueless } from "./condition-rows"
import { conditionPickerId, operatorSelectId } from "./conditions"
import type { QueryDraft } from "./draft"
import { Message, type Model } from "./panel-message"
import { panelSelect } from "./panel-select"
import { Array as Arr, Option, String as Str } from "effect"

// `ConditionBuilder`: the where clause as `[field] [operator] [values]` rows, AND-ed, each
// picked from the query's own vocabulary.

type H = HtmlBuilder<Message>

const GROUP_SHORT = { common: "", resource: "resource", attribute: "attr" }

const fieldTrigger = (h: H, field: ConditionField): ReadonlyArray<Html | string> =>
	field.group === "common"
		? [field.label]
		: [
				typography(h, { tone: "subtle", as: "span", mono: true }, [`${GROUP_SHORT[field.group]}.`]),
				field.label,
			]

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
	values: WhereClauseAutocompleteValues,
): Html => {
	const id = conditionPickerId(query.id, row.id, "field")
	const picker = model.conditionPickers[id] ?? Combobox.init(id, "single")
	const current = { ...picker, selected: row.key === "" ? [] : [row.key] }
	const search = Combobox.queryOf(current)
	const items = fieldPickerItems(fieldsOf(query.dataSource, values), model.fieldDrills[id] ?? "all", search)
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
			ariaLabel: "Field",
			searchPlaceholder: "Search fields…",
			emptyText: "No fields match",
			trigger: row.key === "" ? ["Choose field"] : fieldTrigger(h, fieldOf(row.key, query.dataSource)),
			isPlaceholder: row.key === "",
			triggerClassName: "max-w-56",
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
			toView: (parts) => h.div([h.Class("contents")], parts),
		},
	})
}

const valuePicker = (
	h: H,
	model: Model,
	query: QueryDraft,
	row: ConditionRow,
	values: WhereClauseAutocompleteValues,
): Html => {
	const id = conditionPickerId(query.id, row.id, "values")
	const picker = model.conditionPickers[id] ?? Combobox.init(id, "multiple")
	const suggestions = valueSuggestionsOf(fieldOf(row.key, query.dataSource), query.dataSource, values)
	const typed = Str.trim(picker.inputValue)
	// What is typed is offered first when it is not already a suggestion, so a click adds it too.
	const isTypedNew = typed !== "" && !suggestions.includes(typed) && !row.values.includes(typed)
	return h.submodel({
		slotId: `${model.slotPrefix}-${id}`,
		model: { ...picker, selected: row.values },
		view: chipsView,
		toParentMessage: (message) =>
			Message.GotConditionValues({ queryId: query.id, rowId: row.id, message }),
		viewInputs: {
			items: isTypedNew ? [typed, ...suggestions] : suggestions,
			ariaLabel: "Value",
			placeholder: row.values.length === 0 ? "Value" : "",
			emptyText: "Type a value and press Enter",
			className: "text-xs",
			renderItem: (_, value) => (isTypedNew && value === typed ? [`Use "${value}"`] : [value]),
			toView: (parts) => h.div([h.Class("min-w-40 flex-1")], parts),
		},
	})
}

const conditionRow = (
	h: H,
	model: Model,
	query: QueryDraft,
	row: ConditionRow,
	index: number,
	values: WhereClauseAutocompleteValues,
): Html => {
	const connector = typography(h, { size: "xs", tone: "muted", className: "w-10 shrink-0" }, [
		index === 0 ? "Where" : "and",
	])
	const remove = iconButton(
		h,
		{
			size: "icon-xs",
			label: "Remove condition",
			hasTooltip: false,
			className: "text-muted-foreground hover:text-foreground active:text-foreground",
			attributes: [h.OnClick(Message.ClickedRemoveCondition({ queryId: query.id, rowId: row.id }))],
		},
		[icon(h, "XmarkIcon")],
	)
	const field = fieldPicker(h, model, query, row, values)
	const layout = (parts: ReadonlyArray<Html>) =>
		hstack(h, { gap: "1.5", wrap: true, attributes: [h.DataAttribute("slot", "condition-row")] }, [
			connector,
			field,
			...parts,
			remove,
		])
	if (row.key === "") return layout([])
	const kind = fieldOf(row.key, query.dataSource).kind
	return panelSelect(
		h,
		model,
		operatorSelectId(query.id, row.id),
		row.operator,
		Arr.map(operatorsOf(kind, row.operator), (operator) => ({
			value: operator,
			label: OPERATOR_LABEL[operator],
		})),
		{
			size: "sm",
			className: "w-36",
			ariaLabel: "Operator",
			toView: (parts) =>
				layout([
					...parts,
					...(isValueless(row.operator) ? [] : [valuePicker(h, model, query, row, values)]),
				]),
		},
	)
}

/** The rows, or nothing when there are none: the caller's "Add condition" starts the first. */
export const conditionBuilder = (
	h: H,
	model: Model,
	query: QueryDraft,
	rows: ReadonlyArray<ConditionRow>,
	values: WhereClauseAutocompleteValues,
): ReadonlyArray<Html> =>
	rows.length === 0
		? []
		: [
				vstack(
					h,
					{
						gap: "1.5",
						attributes: [h.AriaLabel(`Conditions for query ${query.name}`), h.Role("group")],
					},
					Arr.map(rows, (row, index) => conditionRow(h, model, query, row, index, values)),
				),
			]
