import type { Page } from "playwright"
import { act, checkBox, clickButton, EMPTY, opsScenarios, SEEDED } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** Releases from the seeded rollouts (payment-svc 3.5.0 raised errors), with GitHub commits. */
const release = opsScenarios("releases", "Releases")

/** A TanStack search value: JSON, URI-encoded. */
const param = (key: string, value: unknown) => `${key}=${encodeURIComponent(JSON.stringify(value))}`
const ROLLING = `/releases?${param("impact", "rolling")}`

const failing = (tag: string) => ({
	faults: {
		failures: {
			[tag]: {
				status: 502,
				body: { _tag: "@maple/http/errors/QueryEngineExecutionError", message: "ui-parity: injected releases failure" },
			},
		},
	},
})

const facetAction = (row: string, action: string) => async (page: Page) => {
	await page.getByText(row, { exact: true }).first().hover()
	await page.getByRole("button", { name: action }).click()
}

export const releasesArea: AreaModule = {
	area: "releases",
	scenarios: [
		release("list", "Last 7 days", "/releases"),
		release("list-errors-up", "Filtered to errors up", "/releases", {
			steps: act(checkBox("errors up")),
		}),
		release("detail", "payment-svc 3.5.0", `/releases/${SEEDED.paymentRelease}`),
		release("list-empty", "Releases (empty org)", "/releases", { dataset: EMPTY }),
		release("list-loading", "Releases held", "/releases", {
			faults: { delays: { "queryEngine.releasesList": 60_000 } },
			settle: "held",
		}),
		release("list-error", "Releases failing", "/releases", failing("queryEngine.releasesList")),
		release("list-health-empty", "Health filter with no match", ROLLING),
		release("list-health-clear", "Health filter cleared from the empty state", ROLLING, {
			steps: act(clickButton("Clear filter")),
		}),
		release("list-chip-remove", "Health chip removed", ROLLING, {
			steps: act(clickButton(/^Remove filter: Health/)),
		}),
		release("list-exclude-env", "Excluding production", "/releases", {
			steps: act(facetAction("production", "Exclude production")),
		}),
		release("list-service-search", "Service facet searched", "/releases", {
			steps: act((page) => page.getByPlaceholder("Search service...").fill("pay")),
		}),
		release("list-service-filter", "Filtered to cart-svc", "/releases", { steps: act(checkBox("cart-svc")) }),
		release("detail-loading", "Detail, releases held", `/releases/${SEEDED.paymentRelease}`, {
			faults: { delays: { "queryEngine.releasesList": 60_000 } },
			settle: "held",
		}),
		release("detail-error", "Detail, releases failing", `/releases/${SEEDED.paymentRelease}`, failing("queryEngine.releasesList")),
		release("detail-no-traffic", "Detail, a sha with no traffic", `/releases/${"ab".repeat(20)}`),
		release("detail-time-preset", "Detail, Last 1 month from the picker", `/releases/${SEEDED.paymentRelease}`, {
			steps: act(clickButton("Last 7 days"), (page) => page.getByRole("dialog").getByRole("button", { name: "Last 1 month" }).click()),
		}),
		release("list-time-picker","Time range picker open", "/releases", {
			steps: act(clickButton("Last 7 days")),
		}),
		release("list-time-preset", "Last 1 month from the picker", "/releases", {
			steps: act(clickButton("Last 7 days"), (page) => page.getByRole("dialog").getByRole("button", { name: "Last 1 month" }).click()),
		}),
	],
}
