import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import * as IncidentMessage from "../page/alerts/incident/message"
import { init, Message, update } from "./escalation-lab"

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

describe("escalation lab", () => {
	it("drops page writes so fixture ids never reach the API", () => {
		const { model } = init({ state: "incident-escalating" })
		const incident = (message: IncidentMessage.Message) =>
			names(update(model, Message.GotIncidentMessage({ message })).commands)
		expect(incident(IncidentMessage.Message.ClickedAcknowledge({ acknowledged: true }))).toEqual([])
		expect(incident(IncidentMessage.Message.ClickedInvestigate())).toEqual([])
	})

	it("keeps the chart runtime the incident rail needs", () => {
		expect(names(init({ state: "incident-escalating" }).commands)).toContain("LoadChartRuntime")
	})
})
