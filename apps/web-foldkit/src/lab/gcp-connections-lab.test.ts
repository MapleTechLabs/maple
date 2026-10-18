import { gcpLogState } from "@maple/web/components/integrations/gcp-connector-state"
import { describe, expect, test } from "vitest"
import { Message as IntegrationsMessage } from "../page/integrations/message"
import { init, Message, update } from "./gcp-connections-lab"

const NOW = Date.UTC(2026, 9, 18, 12)
const opened = () => init({ nowMs: NOW, timeZone: "UTC" }).model

describe("gcp connections lab", () => {
	test("each card gets its own connection id, so its menu and dialogs stay its own", () => {
		const ids = opened().connectors.map((connector) => connector.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	test("the scenarios read as the states they are named for, against the lab clock", () => {
		const model = opened()
		const states = model.connectors.map((connector) => gcpLogState(connector, NOW).kind)
		expect(states[0]).toBe("receiving")
		expect(states[2]).not.toBe(states[0])
	})

	test("Run the script again opens nothing, as legacy's no-op onConfigure", () => {
		const model = opened()
		const connector = model.connectors[4]
		expect(connector?.last_log_error).not.toBeNull()
		if (connector === undefined) return
		const next = update(
			model,
			Message.GotHubMessage({
				message: IntegrationsMessage.ClickedGcpConfigure({
					target: { _tag: "Connection", id: connector.id, stage: "apply" },
				}),
			}),
		)
		expect(next.model.hub.gcpCard.configure).toBeNull()
		expect(next.commands ?? []).toEqual([])
	})
})
