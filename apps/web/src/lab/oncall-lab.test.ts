import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import * as IncidentMessage from "../page/alerts/incident/message"
import { init, Message, update } from "./oncall-lab"

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

describe("on-call lab", () => {
	it("drops page writes so fixture ids never reach the API", () => {
		const { model } = init({ state: "incident-paged" })
		const incident = (message: IncidentMessage.Message) =>
			names(update(model, Message.GotIncidentMessage({ message })).commands)
		expect(incident(IncidentMessage.Message.ClickedAcknowledge({ acknowledged: true }))).toEqual([])
	})
})
