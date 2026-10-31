import { describe, expect, test } from "vitest"
import { CompleteReloadSpin } from "../../page/infra-integrations/gcp/list/command"
import * as GcpList from "../../page/infra-integrations/gcp/list/model"
import { ALL_PROJECTS, MANAGE_CONNECTIONS } from "../../page/infra-integrations/gcp/list/view-project-menu"
import * as Menu from "../../ui/menu"
import { Message, type Model } from "./model"
import { init, LoadIntegrationsPage, update } from "./update"

const list = (model: Model, message: GcpList.Message): Model =>
	update(model, Message.GotListMessage({ message })).model

const menu = (model: Model, message: Menu.Message) =>
	update(model, Message.GotListMessage({ message: GcpList.Message.GotProjectMenuMessage({ message }) }))

describe("Google Cloud list lab", () => {
	test("the page's view pivot keeps the project, the lab's own pivot starts over", () => {
		const scoped = list(
			list(init().model, GcpList.Message.SelectedProject({ project: "acme-prod" })),
			GcpList.Message.ClickedScope({ scope: "5xx" }),
		)
		const paged = list(scoped, GcpList.Message.ClickedView({ view: "pubsub" }))
		expect(paged.state).toEqual({ view: "pubsub", project: "acme-prod", scope: undefined, q: undefined })
		const lab = update(scoped, Message.ClickedLabView({ view: "cloudSql" })).model
		expect(lab.state).toEqual({ view: "cloudSql" })
	})

	test("a project picked in the menu scopes the list and closes the menu", () => {
		const opened = menu(init().model, Menu.Message.ClickedTrigger()).model
		expect(opened.projectMenu.isOpen).toBe(true)
		const picked = menu(
			opened,
			Menu.Message.ClickedItem({ index: 2, item: { kind: "Radio", value: "acme-data" } }),
		).model
		expect([picked.state.project, picked.projectMenu.isOpen]).toEqual(["acme-data", false])
		const all = menu(
			menu(picked, Menu.Message.ClickedTrigger()).model,
			Menu.Message.ClickedItem({ index: 0, item: { kind: "Radio", value: ALL_PROJECTS } }),
		).model
		expect(all.state.project).toBeUndefined()
	})

	test("Manage connections leaves the lab for the integration page", () => {
		const opened = menu(init().model, Menu.Message.ClickedTrigger()).model
		const left = menu(
			opened,
			Menu.Message.ClickedItem({ index: 5, item: { kind: "Item", value: MANAGE_CONNECTIONS } }),
		)
		expect(left.commands?.map((command) => command.name)).toContain(LoadIntegrationsPage.name)
		expect(left.model.state).toEqual(opened.state)
	})

	test("a search filters until it is cleared", () => {
		const searched = list(init().model, GcpList.Message.ChangedSearch({ value: "checkout" }))
		expect(searched.state.q).toBe("checkout")
		expect(list(searched, GcpList.Message.ClickedClearSearch()).state.q).toBeUndefined()
	})

	test("Reload spins until its own spin ends and sends no reads", () => {
		const reload = update(
			init().model,
			Message.GotListMessage({ message: GcpList.Message.ClickedReload() }),
		)
		expect(reload.model.isReloading).toBe(true)
		expect(reload.commands?.map((command) => command.name)).toEqual([CompleteReloadSpin.name])
		const again = list(reload.model, GcpList.Message.ClickedReload())
		const stale = list(
			again,
			GcpList.Message.CompletedReloadSpin({ version: reload.model.refreshVersion }),
		)
		expect(stale.isReloading).toBe(true)
		const done = list(stale, GcpList.Message.CompletedReloadSpin({ version: again.refreshVersion }))
		expect(done.isReloading).toBe(false)
	})
})
