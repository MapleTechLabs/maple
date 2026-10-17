import type { Page } from "playwright"
import { clickButton, EMPTY, opsScenarios, act } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** Service map variants: a selected service, the namespace collapsed, colored by health, empty org. */
const map = opsScenarios("service-map", "Service map")

const selectNode = (name: string) => (page: Page) =>
	page.getByRole("application").getByText(name, { exact: true }).first().click()

const pickOption = (combobox: string, option: string) => async (page: Page) => {
	await page.getByRole("combobox", { name: combobox }).click()
	await page.getByRole("option", { name: option }).click()
}

export const serviceMapArea: AreaModule = {
	area: "service-map",
	scenarios: [
		map("selected", "payment-svc selected", "/service-map", { steps: act(selectNode("payment-svc")) }),
		map("collapsed", "shop namespace collapsed", "/service-map", {
			steps: act(clickButton("Collapse shop into one node")),
		}),
		map("color-health", "Nodes colored by health", "/service-map", {
			steps: act(pickOption("Color nodes by", "Health")),
		}),
		map("empty", "Service map (empty org)", "/service-map", { dataset: EMPTY }),
	],
}
