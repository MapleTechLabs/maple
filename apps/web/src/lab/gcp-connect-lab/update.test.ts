import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import { Message as IntegrationsMessage } from "../../page/integrations/message"
import * as ToggleGroup from "../../ui/toggle-group"
import { LAB_STATES } from "./fixture"
import { Message } from "./model"
import { init, update } from "./update"

const NOW = Date.UTC(2026, 9, 18, 12)
const opened = () => init({ nowMs: NOW, timeZone: "UTC" }).model

const pick = (model: ReturnType<typeof opened>, state: (typeof LAB_STATES)[number]) =>
	update(
		model,
		Message.GotStateGroupMessage({
			message: ToggleGroup.Message.ClickedItem({ value: state, index: LAB_STATES.indexOf(state) }),
		}),
	).model

describe("gcp connect lab", () => {
	test("opens on a new connection's first step, with the dialog open", () => {
		const model = opened()
		expect(model.state).toBe("new")
		expect(model.hub.gcpCard.configure?.target._tag).toBe("New")
		expect(model.hub.gcpCard.configure?.dialog.isOpen).toBe(true)
	})

	test("a run state opens the run step on its fixture script", () => {
		const model = pick(opened(), "failed")
		const configure = model.hub.gcpCard.configure
		expect(model.stateGroup.values).toEqual(["failed"])
		expect(configure?.opened).not.toBeNull()
		expect(
			configure !== null && configure !== undefined && AsyncData.isFailure(configure.scripts.data),
		).toBe(true)
	})

	test("pressing the current state again keeps it pressed", () => {
		const model = pick(opened(), "new")
		expect([model.state, model.stateGroup.values]).toEqual(["new", ["new"]])
	})

	test("Close unmounts the wizard and Reopen brings it back from its first step", () => {
		const waiting = pick(opened(), "waiting")
		const closed = update(
			waiting,
			Message.GotHubMessage({ message: IntegrationsMessage.ClosedGcpConfigure() }),
		).model
		expect(closed.hub.gcpCard.configure).toBeNull()
		const reopened = update(closed, Message.ClickedReopen()).model
		expect(reopened.hub.gcpCard.configure?.opened?.rerun).toBe(false)
	})
})
