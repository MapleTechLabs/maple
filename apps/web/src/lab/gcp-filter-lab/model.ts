import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LogFilterDraft } from "../../page/integrations/gcp-configure-schema"
import { Message as IntegrationsMessage } from "../../page/integrations/message"
import * as Select from "../../ui/select"

// `/lab/gcp`: the Google Cloud configuration's Log filter over plain
// state, in each place it shows up. Each card prints what the setup script would be asked for.

export type Scenario = Readonly<{
	title: string
	description: string
	sinkExists: boolean
	initial: LogFilterDraft
}>

export const SCENARIOS: ReadonlyArray<Scenario> = [
	{
		title: "New connection",
		description: "No sink yet: platform logs only, until OpenTelemetry is ruled out.",
		sinkExists: false,
		initial: { keep: null, runtimes: null },
	},
	{
		title: "New connection, OpenTelemetry ruled out",
		description: "After “Forward application output instead”, with Cloud Run ticked.",
		sinkExists: false,
		initial: { keep: null, runtimes: ["cloud_run"] },
	},
	{
		title: "Existing sink, keep",
		description: "Configure on a connection whose sink exists: its filter is left alone.",
		sinkExists: true,
		initial: { keep: null, runtimes: null },
	},
	{
		title: "Existing sink, replace",
		description: "Configure with Replace filter chosen.",
		sinkExists: true,
		initial: { keep: false, runtimes: null },
	},
]

/** One card's `useState`: the draft, and its Keep/Replace select. */
export const ScenarioState = Schema.Struct({ filter: LogFilterDraft, filterMode: Select.Model })
export type ScenarioState = typeof ScenarioState.Type

export const Model = Schema.Struct({ scenarios: Schema.Array(ScenarioState) })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	/** The card's field speaks the integrations page's Messages (`GcpLogFilterField`'s `onFilter`). */
	GotScenarioMessage: { index: Schema.Number, message: IntegrationsMessage },
})
export type Message = typeof Message.Type
