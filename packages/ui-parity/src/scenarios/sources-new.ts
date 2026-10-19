import type { Page } from "playwright"
import { act, clickButton, opsScenarios } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** `/sources/new`: the platform picker, the create form and the one-time token step, on Acme. */
const connect = opsScenarios("sources-new", "Connect a source")

const waitForText = (text: string | RegExp) => (page: Page) =>
	page.getByText(text).first().waitFor({ state: "visible" })

const nodejs = "/sources/new?platform=nodejs"
const kubernetes = "/sources/new?platform=kubernetes"

const reservedKey = async (page: Page) => {
	await page.getByPlaceholder("service.name").first().fill("maple_env")
}

export const sourcesNewArea: AreaModule = {
	area: "sources-new",
	scenarios: [
		connect("picker", "Pick a platform", "/sources/new", { dataset: "default" }),
		connect("form", "Node.js form", nodejs, { dataset: "default" }),
		connect("form-advanced", "Node.js form, Advanced open", nodejs, {
			dataset: "default",
			steps: act(clickButton("Advanced"), waitForText("Resource attributes")),
		}),
		connect("form-reserved-key", "Node.js form, reserved attribute key", nodejs, {
			dataset: "default",
			steps: act(
				clickButton("Advanced"),
				clickButton("Add attribute"),
				reservedKey,
				waitForText('"maple_env" is reserved by Maple.'),
			),
		}),
		connect("token-nodejs", "Node.js created, token and first data", nodejs, {
			dataset: "default",
			steps: act(clickButton("Create source"), waitForText("Receiving data")),
		}),
		connect("token-waiting", "Node.js created, waiting for first data", nodejs, {
			dataset: "default",
			faults: { delays: { "sources.retrieve": 60_000 } },
			steps: act(clickButton("Create source"), waitForText("Waiting for first data")),
		}),
		connect("token-kubernetes", "Kubernetes created, Helm snippet", kubernetes, {
			dataset: "default",
			steps: act(clickButton("Create source"), waitForText("Receiving data")),
		}),
	],
}
