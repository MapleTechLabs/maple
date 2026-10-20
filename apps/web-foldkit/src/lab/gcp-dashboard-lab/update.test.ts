import { variableValuesFromSearch } from "../../lib/dashboard-controls/search-params"
import { resolveSectionView } from "../../lib/dashboards/section-view-state"
import { describe, expect, test } from "vitest"
import { Message } from "../../page/dashboards/view/message"
import { optionsByNameOf, variablesOf } from "../../page/dashboards/view/plan"
import { fixtureRows } from "./fixture"
import { CONTEXT, init, update } from "./update"

const API = /^(FetchDashboard|SaveDashboard|UpdateDashboard)/
const NOW = Date.UTC(2026, 9, 15)

const opened = () => {
	const started = init()
	const clocked = update(started.model, Message.CompletedReadClock({ nowMs: NOW }))
	return { model: clocked.model, commands: [...started.commands, ...clocked.commands] }
}

describe("gcp dashboard lab", () => {
	test("boots the template board without asking the API anything", () => {
		const { model, commands } = opened()
		expect(model.document?.name).toBe("Google Cloud")
		expect(commands.map((command) => command.name).filter((name) => API.test(name))).toEqual([])
	})

	test("the metric variables list the fixture's options, not loading", () => {
		const options = optionsByNameOf(opened().model, CONTEXT)
		expect(options.project).toEqual({ options: ["acme-prod", "acme-staging"], loading: false })
		expect(options.region).toEqual({ options: ["europe-west1", "us-central1"], loading: false })
	})

	test("a tab switch stays in the lab's own search", () => {
		const next = update(opened().model, Message.ClickedSectionTab({ sectionId: "gcp-services", tabId: "gke" }))
		const document = next.model.document
		const view = resolveSectionView(document?.sections ?? [], document?.widgets ?? [], next.model.search)
		expect(view.activeTabs.get("gcp-services")).toBe("gke")
		expect(next.commands.map((command) => command.name).filter((name) => API.test(name))).toEqual([])
	})

	test("a picked project narrows the series of widgets that filter on it", () => {
		const drafted = update(opened().model, Message.ChangedVariableDraft({ name: "project", value: "acme-staging" }))
		const picked = update(drafted.model, Message.CommittedVariableDraft({ name: "project" })).model
		expect(variableValuesFromSearch(picked.search).project).toBe("acme-staging")
		const widget = picked.document?.widgets.find((candidate) => candidate.id === "run-requests")
		const rows = widget === undefined ? [] : fixtureRows(widget, variablesOf(picked, CONTEXT).values)
		expect(Object.keys(rows[0] ?? {}).toSorted()).toEqual(["bucket", "checkout"])
	})
})
