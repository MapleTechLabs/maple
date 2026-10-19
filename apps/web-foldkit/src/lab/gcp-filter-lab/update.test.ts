import { gcpLogFilterChoice } from "@maple/web/components/integrations/gcp-connector-state"
import { describe, expect, test } from "vitest"
import { Message as IntegrationsMessage } from "../../page/integrations/message"
import { Message, SCENARIOS } from "./model"
import { init, update } from "./update"

const applicationLogsOf = (model: ReturnType<typeof init>, index: number) => {
	const state = model.scenarios[index]
	const scenario = SCENARIOS[index]
	return state === undefined || scenario === undefined
		? null
		: gcpLogFilterChoice(state.filter, scenario.sinkExists).applicationLogs
}

const send = (model: ReturnType<typeof init>, index: number, message: IntegrationsMessage) =>
	update(model, Message.GotScenarioMessage({ index, message })).model

describe("gcp log filter lab", () => {
	test("each card starts on its scenario's draft", () => {
		const model = init()
		expect([0, 1, 2, 3].map((index) => applicationLogsOf(model, index))).toEqual([
			[],
			["cloud_run"],
			undefined,
			[],
		])
	})

	test("ruling OpenTelemetry out and ticking a runtime changes only that card", () => {
		const ruledOut = send(init(), 0, IntegrationsMessage.ClickedGcpForwardOutput())
		const ticked = send(ruledOut, 0, IntegrationsMessage.ToggledGcpRuntime({ runtime: "app_engine" }))
		expect(applicationLogsOf(ticked, 0)).toEqual(["app_engine"])
		expect(applicationLogsOf(ticked, 1)).toEqual(["cloud_run"])
	})

	test("Use OpenTelemetry instead closes the runtime ticks again", () => {
		const back = send(init(), 1, IntegrationsMessage.ClickedGcpUseOpenTelemetry())
		expect(back.scenarios[1]?.filter.runtimes).toBeNull()
	})
})
