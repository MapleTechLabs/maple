import type { Page } from "playwright"
import { act, clickButton, opsScenarios, SEEDED } from "./ops-kit.ts"
import type { Scenario } from "./types.ts"

/**
 * The variables board (`dash_parity_ops_variables`): a custom, a query and a textbox variable whose
 * values ride `var-*` in the URL and filter the widgets; the manager dialog in edit mode.
 */
const dashboard = opsScenarios("dashboards", "Dashboards")
const board = `/dashboards/${SEEDED.variablesDashboard}`
const platform = `/dashboards/${SEEDED.platformDashboard}`

const enterEdit = clickButton("Edit dashboard")
const openVariable = (name: string) => (page: Page) => page.getByRole("combobox", { name }).click()
const clickOption = (name: string) => (page: Page) => page.getByRole("option", { name }).first().click()

export const variableScenarios: ReadonlyArray<Scenario> = [
	dashboard("variables", "Variables board: defaults resolved, widgets filtered", board),
	dashboard("variables-from-url", "Variables board: a value from the URL", `${board}?var-env=%22staging%22`),
	dashboard("variables-open", "Variables board: a variable's value list open", board, {
		steps: act(openVariable("Environment variable")),
	}),
	dashboard("variables-picked", "Variables board: another value picked", board, {
		steps: act(openVariable("Environment variable"), clickOption("staging")),
	}),
	dashboard("variables-textbox", "Variables board: a textbox variable typed", board, {
		steps: act(async (page) => {
			const input = page.getByRole("textbox", { name: "route variable" })
			await input.fill("/checkout")
			await input.press("Enter")
		}),
	}),
	dashboard("variables-edit", "Variables board in edit mode", board, { steps: act(enterEdit) }),
	dashboard("variables-manager", "Variables board: the variables manager", board, {
		steps: act(enterEdit, clickButton("Manage dashboard variables")),
	}),
	dashboard("variables-manager-edit", "Variables board: a variable's form open in the manager", board, {
		steps: act(enterEdit, clickButton("Manage dashboard variables"), (page) =>
			page.getByRole("button", { name: "Edit variable" }).first().click(),
		),
	}),
	dashboard("variables-manager-empty", "Edit mode: the variables manager on a board with none", platform, {
		steps: act(enterEdit, clickButton("Add dashboard variable")),
	}),
	dashboard("variables-saved", "Variables board: a variable removed and saved", board, {
		steps: act(
			enterEdit,
			clickButton("Manage dashboard variables"),
			(page) => page.getByRole("button", { name: "Delete variable" }).nth(2).click(),
			clickButton("Save variables"),
		),
	}),
]
