import {
	pickDashboardControlParams,
	variableValuesFromSearch,
} from "../../../lib/dashboard-controls/search-params"
import { Command } from "foldkit"
import { AppRoute, hrefOf } from "../../../route"
import * as Combobox from "../../../ui/combobox"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { variablesOf } from "./plan"

// `VariableSelects` and `handleVariableChange`: a picked or typed value rides `var-<name>` in the URL
// (replace), so a view is shareable; the root re-enters the route and the tiles re-plan.

type Return = PageReturn<Model, Message>

export const variableComboIdOf = (name: string): string => `dashboard-variable-${name}`

/** `setValue`: an unchanged value navigates nowhere. */
const setValue = (model: Model, name: string, value: string): Return => {
	if (variableValuesFromSearch(model.search)[name] === value) return { model }
	const controls = pickDashboardControlParams(model.search)
	const search = {
		...controls,
		...(model.search.mode === "edit" ? { mode: "edit" as const } : undefined),
		[`var-${name}`]: value,
	}
	return {
		model,
		outMessage: PageOutMessage.RequestedNavigation({
			url: hrefOf(
				AppRoute.Dashboard({
					dashboardId: AppRoute.Dashboard.fields.dashboardId.make(model.dashboardId),
					search,
				}),
			),
			isReplace: true,
		}),
	}
}

const comboStep = (model: Model, context: PageContext, name: string, message: Combobox.Message): Return => {
	const current = variablesOf(model, context).values[name]
	const combo =
		model.variableComboName === name
			? model.variableCombo
			: Combobox.init(variableComboIdOf(name), "single", {
					selected: current === undefined ? [] : [current.value],
				})
	const next = Combobox.update(combo, message)
	const updated = { ...model, variableCombo: next.model, variableComboName: name }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotVariableComboMessage({ name, message: inner }),
	)
	const out = next.outMessage
	if (out === undefined || out._tag !== "ChangedValue" || out.value === "")
		return { model: updated, commands }
	const set = setValue(updated, name, out.value)
	return { ...set, commands: [...commands, ...(set.commands ?? [])] }
}

type VariableMessage = Extract<
	Message,
	{ readonly _tag: "GotVariableComboMessage" | "ChangedVariableDraft" | "CommittedVariableDraft" }
>

export const variableStep = (model: Model, context: PageContext, message: VariableMessage): Return => {
	switch (message._tag) {
		case "GotVariableComboMessage":
			return comboStep(model, context, message.name, message.message)
		case "ChangedVariableDraft":
			return {
				model: {
					...model,
					variableDrafts: { ...model.variableDrafts, [message.name]: message.value },
				},
			}
		case "CommittedVariableDraft": {
			const draft = model.variableDrafts[message.name]
			const { [message.name]: _committed, ...rest } = model.variableDrafts
			const cleared = { ...model, variableDrafts: rest }
			const current = variablesOf(model, context).values[message.name]?.value ?? ""
			return draft === undefined || draft === current
				? { model: cleared }
				: setValue(cleared, message.name, draft)
		}
	}
}
