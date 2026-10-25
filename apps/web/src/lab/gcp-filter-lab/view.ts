import { gcpLogFilterChoice } from "../../components/integrations/gcp-connector-state"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Message as IntegrationsMessage } from "../../page/integrations/message"
import { filterField } from "../../page/integrations/view-gcp-configure-filter"
import { dashboardPage } from "../../page/kit/dashboard-page"
import { Message, type Model, type Scenario, SCENARIOS, type ScenarioState } from "./model"

type H = HtmlBuilder<Message>

/** The card around `GcpLogFilterField`, labelled, with ids of its own. */
const cardView = Submodel.defineView<
	ScenarioState,
	IntegrationsMessage,
	Readonly<{ index: number; sinkExists: boolean }>
>((state, inputs, h) =>
	h.div(
		[h.Class("rounded-xl border bg-popover p-6")],
		[
			filterField(h, state, {
				sinkExists: inputs.sinkExists,
				logRouter: inputs.sinkExists ? "https://console.cloud.google.com/logs/router" : undefined,
				labelId: `gcp-lab-filter-${inputs.index}-label`,
				forwardId: `gcp-lab-filter-${inputs.index}-forward`,
			}),
		],
	),
)

const scenarioView = (h: H, scenario: Scenario, state: ScenarioState, index: number): Html => {
	const { applicationLogs } = gcpLogFilterChoice(state.filter, scenario.sinkExists)
	return h.section(
		[h.Key(scenario.title), h.Class("flex flex-col gap-3")],
		[
			h.div(
				[],
				[
					h.h2([h.Class("text-sm font-medium")], [scenario.title]),
					h.p([h.Class("text-xs text-muted-foreground")], [scenario.description]),
				],
			),
			h.submodel({
				slotId: `gcp-lab-filter-${index}`,
				model: state,
				view: cardView,
				viewInputs: { index, sinkExists: scenario.sinkExists },
				toParentMessage: (message) => Message.GotScenarioMessage({ index, message }),
			}),
			h.p(
				[h.Class("font-mono text-xs text-muted-foreground")],
				[
					"application_logs:",
					" ",
					applicationLogs === undefined
						? "omitted (keep the filter)"
						: JSON.stringify(applicationLogs),
				],
			),
		],
	)
}

export const view = (model: Model, h: H): Html =>
	dashboardPage(h, {}, [
		h.div(
			[h.Class("mx-auto flex w-full max-w-2xl flex-col gap-8 p-4")],
			SCENARIOS.flatMap((scenario, index) => {
				const state = model.scenarios[index]
				return state === undefined ? [] : [scenarioView(h, scenario, state, index)]
			}),
		),
	])
