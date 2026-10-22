import type { Html, HtmlBuilder } from "foldkit/html"
import { inlineCode } from "../../../../ui/inline-code"
import { settingRow } from "../../../../ui/setting-row"
import { switchControl } from "../../../../ui/switch"
import { METRIC_TYPE_LABELS, METRIC_TYPES, SOURCE_ITEMS, TYPE_OPTIONS, VARIABLE_TYPES } from "./derive"
import { Message, type Model, type Variable } from "./model"
import { itemsOf, selectField, textField } from "./view-fields"

// `VariableForm` and `QuerySourceFields`: the expanded draft's controls.

type H = HtmlBuilder<Message>

const grid = (h: H, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("grid grid-cols-2 gap-3")], children)

const querySourceFields = (h: H, model: Model, variable: Extract<Variable, { type: "query" }>): Html => {
	const source = variable.source
	return grid(h, [
		selectField(h, model, {
			key: "sourceSelect",
			label: "Values from",
			entries: itemsOf(SOURCE_ITEMS),
			wrap: (message) => Message.GotSourceSelectMessage({ message }),
		}),
		...(source.kind === "facet"
			? []
			: [
					textField(h, model, {
						field: "attributeKey",
						label: "Attribute key",
						placeholder: "http.route",
					}),
				]),
		...(source.kind === "metric"
			? [
					textField(h, model, {
						field: "metricNames",
						label: "Metrics",
						placeholder: "http.server.duration",
					}),
					selectField(h, model, {
						key: "metricTypeSelect",
						label: "Metric type",
						entries: itemsOf(
							METRIC_TYPES.map((value) => ({ value, label: METRIC_TYPE_LABELS[value] })),
						),
						wrap: (message) => Message.GotMetricTypeSelectMessage({ message }),
					}),
				]
			: []),
	])
}

const includeAllRow = (h: H, model: Model, variable: Variable): Html => {
	const id = `${model.dialog.id}-include-all`
	const isChecked = variable.includeAll === true
	return settingRow(h, {
		ids: { control: `${id}-input`, label: `${id}-label`, description: `${id}-description` },
		label: h.span([h.Class("text-xs")], ['Include "All" option']),
		description: "All drops the filter in query builders and expands to every value in SQL.",
		filled: isChecked,
		control: switchControl(h, {
			id,
			inputId: `${id}-input`,
			isChecked,
			isFilled: isChecked,
			labelledBy: `${id}-label`,
			describedBy: `${id}-description`,
			onToggle: Message.ToggledIncludeAll(),
		}),
	})
}

export const variableForm = (h: H, model: Model, variable: Variable, error: string | null): Html =>
	h.div(
		[h.Class("flex flex-col gap-3")],
		[
			grid(h, [
				textField(h, model, {
					field: "name",
					label: "Name",
					placeholder: "service",
					isInvalid: error !== null,
					autoFocus: variable.name === "",
					error,
					description:
						variable.name === ""
							? null
							: [
									"Reference it as ",
									inlineCode(h, {}, [`$${variable.name}`]),
									" in widget filters and SQL.",
								],
				}),
				textField(h, model, {
					field: "label",
					label: "Label",
					placeholder: variable.name === "" ? "Optional display label" : variable.name,
				}),
			]),
			grid(h, [
				selectField(h, model, {
					key: "typeSelect",
					label: "Type",
					entries: itemsOf(VARIABLE_TYPES.map((value) => ({ value, label: TYPE_OPTIONS[value] }))),
					wrap: (message) => Message.GotTypeSelectMessage({ message }),
				}),
				textField(h, model, {
					field: "defaultValue",
					label: "Default value",
					placeholder: "Optional",
				}),
			]),
			...(variable.type === "query" ? [querySourceFields(h, model, variable)] : []),
			...(variable.type === "custom"
				? [
						textField(h, model, {
							field: "options",
							label: "Options (comma-separated)",
							placeholder: "production, staging, development",
							isTextarea: true,
						}),
					]
				: []),
			...(variable.type === "textbox" ? [] : [includeAllRow(h, model, variable)]),
		],
	)
