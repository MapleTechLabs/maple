import { Command, type Update } from "foldkit"
import { Message as IntegrationsMessage } from "../../page/integrations/message"
import { runtimeToggled } from "../../page/integrations/update-gcp-configure"
import type { Resources } from "../../platform/resources"
import * as Select from "../../ui/select"
import { Message, type Model, SCENARIOS, type ScenarioState } from "./model"

export type Return = Update.Return<Model, Message, Resources>

type Step = Readonly<{
	state: ScenarioState
	commands: ReadonlyArray<Command.Command<IntegrationsMessage, never, Resources>>
}>

export const init = (): Model => ({
	scenarios: SCENARIOS.map((scenario, index) => ({
		filter: scenario.initial,
		filterMode: Select.init(`gcp-lab-filter-mode-${index}`, {
			value: scenario.initial.keep === false ? "set" : "keep",
			selectedIndex: scenario.initial.keep === false ? 1 : 0,
		}),
	})),
})

/** `onFilter`: the field's controls edit the card's draft; anything else is not the field's. */
const step = (state: ScenarioState, message: IntegrationsMessage): Step => {
	const withFilter = (patch: Partial<ScenarioState["filter"]>): Step => ({
		state: { ...state, filter: { ...state.filter, ...patch } },
		commands: [],
	})
	switch (message._tag) {
		case "ClickedGcpForwardOutput":
			return withFilter({ runtimes: [] })
		case "ClickedGcpUseOpenTelemetry":
			return withFilter({ runtimes: null })
		case "ToggledGcpRuntime":
			return withFilter(runtimeToggled(state.filter, message.runtime))
		case "GotGcpFilterModeMessage": {
			const next = Select.update(state.filterMode, message.message)
			const commands = Command.mapMessages(next.commands ?? [], (inner) =>
				IntegrationsMessage.GotGcpFilterModeMessage({ message: inner }),
			)
			const picked = next.outMessage?._tag === "ChangedValue" ? next.outMessage.value : null
			const filter = picked === null ? state.filter : { ...state.filter, keep: picked === "keep" }
			return { state: { ...state, filterMode: next.model, filter }, commands }
		}
		default:
			return { state, commands: [] }
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotScenarioMessage: ({ index, message: inner }) => {
			const state = model.scenarios[index]
			if (state === undefined) return { model }
			const next = step(state, inner)
			return {
				model: { scenarios: model.scenarios.map((entry, at) => (at === index ? next.state : entry)) },
				commands: Command.mapMessages(next.commands, (child) =>
					Message.GotScenarioMessage({ index, message: child }),
				),
			}
		},
	})
