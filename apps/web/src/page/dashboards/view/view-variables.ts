import { ALL_VALUE, type ResolvedVariable } from "@maple/query-engine"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import * as Combobox from "../../../ui/combobox"
import { chipsInput, hiddenInput, inputAttributes, listPopup } from "../../../ui/combobox-view"
import { icon } from "../../../ui/icon"
import { inputGroup, inputGroupAddon, inputGroupInput } from "../../../ui/input-group"
import { isMounted } from "../../../ui/overlay/transition"
import type { PageContext } from "../../contract"
import type { Variable as DashboardVariable } from "../kit/variables"
import { Message } from "./message"
import type { Model } from "./model"
import { optionsByNameOf, variablesOf } from "./plan"
import { variableComboIdOf } from "./variable-update"

// The variable selects: one chip per variable, and in
// edit mode the `+` chip that opens the manager.

type H = HtmlBuilder<Message>
type OptionsState = Readonly<{ options: ReadonlyArray<string>; loading: boolean }>

const chipLabel = (variable: DashboardVariable): string => variable.label ?? variable.name

const displayValue = (resolved: ResolvedVariable | undefined, options: OptionsState): string =>
	resolved === undefined
		? options.loading
			? "…"
			: EMPTY_VALUE
		: resolved.isAll
			? "All"
			: resolved.value === ""
				? EMPTY_VALUE
				: resolved.value

/** The list's items: All first, and a pinned value kept selectable when it is not listed yet. */
const itemsOf = (variable: DashboardVariable, resolved: ResolvedVariable | undefined, options: OptionsState) => {
	const value = resolved?.isAll === true ? ALL_VALUE : (resolved?.value ?? "")
	const all = variable.includeAll === true ? [ALL_VALUE] : []
	const pinned = value !== "" && value !== ALL_VALUE && !options.options.includes(value) ? [value] : []
	return [...all, ...pinned, ...options.options]
}

type ChipInputs = Readonly<{
	variable: DashboardVariable
	resolved: ResolvedVariable | undefined
	options: OptionsState
}>

const chipView = Submodel.defineView<Combobox.Model, Combobox.Message, ChipInputs>((model, inputs, h) => {
	const label = chipLabel(inputs.variable)
	const items = itemsOf(inputs.variable, inputs.resolved, inputs.options)
	const triggerId = `${model.id}-trigger`
	const anchor = `[data-variable-anchor="${model.id}"]`
	const isVisible = isMounted(model.isOpen, model.animation)
	const searchModel = { ...model, inputValue: Combobox.queryOf(model) }
	return h.span([h.Class("contents")], [
		h.span(
			[h.Class("inline-flex"), h.DataAttribute("variable-anchor", model.id)],
			[
				button(
					h,
					{
						variant: "outline",
						size: "sm",
						className: "max-w-64 gap-1.5 font-mono",
						isDisabled: inputs.resolved === undefined && inputs.options.loading,
						slot: "combobox-trigger",
						attributes: [
							...(isVisible ? [h.AriaControls(`${model.id}-popup`)] : []),
							h.AriaExpanded(model.isOpen),
							h.AriaHasPopup("dialog"),
							h.AriaLabel(`${label} variable`),
							...(model.isOpen
								? [h.DataAttribute("popup-open", ""), h.DataAttribute("popup-side", model.side), h.DataAttribute("pressed", "")]
								: []),
							h.Id(triggerId),
							h.Role("combobox"),
							h.Tabindex(0),
							h.OnClick(Combobox.Message.ClickedTriggerOf({ items })),
						],
					},
					[
						h.span([h.Class("text-muted-foreground")], [label]),
						h.span(
							[h.Class(cn("truncate", inputs.resolved === undefined && "text-muted-foreground"))],
							[displayValue(inputs.resolved, inputs.options)],
						),
						icon(h, "ChevronDownIcon", { size: 12, className: "shrink-0 text-muted-foreground" }),
					],
				),
			],
		),
		hiddenInput(h, { ...model, inputValue: model.selected[0] ?? "" }),
		...(isVisible
			? [
					listPopup(h, model, {
						slot: "combobox",
						items,
						emptyText: inputs.options.loading ? "Loading values…" : "No matching values",
						anchorSelector: anchor,
						className: "min-w-52",
						listClassName: "max-h-72 overflow-y-auto p-1",
						itemClassName: (value) => (value === ALL_VALUE ? "text-xs" : "font-mono text-xs"),
						renderItem: (value) =>
							value === ALL_VALUE
								? ["All", h.span([h.Class("ml-auto pl-4 text-3xs text-muted-foreground")], ["no filter"])]
								: [value],
						trigger: {
							returnFocusId: triggerId,
							sideOffset: 6,
							header: h.div(
								[h.Class("border-b border-border px-1.5 py-1.5")],
								[
									chipsInput(h, {
										size: "sm",
										className: "w-full font-mono",
										attributes: inputAttributes(
											h,
											searchModel,
											{ slot: "combobox-chips-input", placeholder: `Search ${label}…`, items },
											(message) => message,
										),
									}),
								],
							),
						},
					}),
				]
			: []),
	])
})

const textboxControl = (h: H, model: Model, variable: DashboardVariable, current: string): Html => {
	const label = chipLabel(variable)
	const name = variable.name
	return inputGroup(h, { className: "h-8 w-auto text-xs sm:text-xs" }, [
		inputGroupAddon(h, { className: "border-r border-input pe-2 font-mono text-muted-foreground" }, [label]),
		inputGroupInput(h, {
			id: `${variableComboIdOf(name)}-input`,
			size: "sm",
			controlClassName: "w-28 font-mono",
			attributes: [
				// Keyed by the committed value, so a URL change resets the input.
				h.Key(`textbox-${name}-${current}`),
				h.Value(model.variableDrafts[name] ?? current),
				h.Placeholder("any"),
				h.AriaLabel(`${label} variable`),
				h.OnInput((value) => Message.ChangedVariableDraft({ name, value })),
				h.OnBlur(Message.CommittedVariableDraft({ name })),
				h.OnKeyDownPreventDefault((key) =>
					key === "Enter" ? Option.some(Message.CommittedVariableDraft({ name })) : Option.none(),
				),
			],
		}),
	])
}

const comboOf = (model: Model, name: string, resolved: ResolvedVariable | undefined): Combobox.Model =>
	model.variableComboName === name
		? model.variableCombo
		: Combobox.init(variableComboIdOf(name), "single", {
				selected: resolved === undefined ? [] : [resolved.isAll ? ALL_VALUE : resolved.value],
			})

const control = (h: H, model: Model, context: PageContext, variable: DashboardVariable): Html => {
	const resolved = variablesOf(model, context).values[variable.name]
	if (variable.type === "textbox") return textboxControl(h, model, variable, resolved?.value ?? "")
	return h.submodel({
		slotId: `dashboard-variable-${variable.name}`,
		model: comboOf(model, variable.name, resolved),
		view: chipView,
		viewInputs: {
			variable,
			resolved,
			options: optionsByNameOf(model, context)[variable.name] ?? { options: [], loading: false },
		},
		toParentMessage: (message) => Message.GotVariableComboMessage({ name: variable.name, message }),
	})
}

/** `VariableSelects`: nothing on a board without variables outside edit mode. */
export const variableSelects = (h: H, model: Model, context: PageContext, canManage: boolean): ReadonlyArray<Html> => {
	const variables = model.document?.variables ?? []
	if (variables.length === 0 && !canManage) return []
	return [
		h.div(
			[h.Class("flex items-center gap-1.5")],
			[
				...variables.map((variable) => control(h, model, context, variable)),
				...(canManage
					? [
							button(
								h,
								{
									variant: "ghost",
									size: "sm",
									className: "text-muted-foreground",
									attributes: [
										h.AriaLabel(variables.length === 0 ? "Add dashboard variable" : "Manage dashboard variables"),
										h.OnClick(Message.ClickedManageVariables()),
									],
								},
								[
									icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
									...(variables.length === 0 ? ["Variable"] : []),
								],
							),
						]
					: []),
			],
		),
	]
}
