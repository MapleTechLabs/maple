import type { Page } from "playwright"
import { act, EMPTY, opsScenarios } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** `/sources`: Acme's sources (fixtures/areas/sources.ts), and an org with only its default source. */
const sources = opsScenarios("sources", "Sources")
const DEFAULT = "default"

const failing = {
	faults: {
		failures: {
			"sources.list": {
				status: 500,
				body: {
					_tag: "@maple/http/errors/SourcePersistenceError",
					message: "ui-parity: injected sources failure",
				},
			},
		},
	},
}

/** A click on the row outside its name link opens the source too. */
const clickPlatformCell = (page: Page) =>
	page.getByRole("row", { name: /Staging cluster/ }).getByText("Kubernetes", { exact: true }).click()
const waitForSourcePage = (page: Page) => page.waitForURL(/\/sources\/src_/)

export const sourcesListArea: AreaModule = {
	area: "sources",
	scenarios: [
		sources("list", "Acme's sources", "/sources", { dataset: DEFAULT }),
		sources("list-empty", "Only the default source", "/sources", { dataset: EMPTY }),
		sources("list-loading", "List held", "/sources", {
			dataset: DEFAULT,
			faults: { delays: { "sources.list": 60_000 } },
			settle: "held",
		}),
		sources("list-error", "List failing", "/sources", { dataset: DEFAULT, ...failing }),
		sources("list-open-row", "Open a source from its row", "/sources", {
			dataset: DEFAULT,
			steps: act(clickPlatformCell, waitForSourcePage),
		}),
	],
}
