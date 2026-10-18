import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * Agent Sessions on dataset `agent-sessions` (eight sessions over the week from four vendors,
 * with tool and model failures), and the same pages on the empty org.
 */
const DATASET = "agent-sessions"
const EMPTY = "empty"
/** The newest seeded session (`src/fixtures/telemetry/agent-sessions.ts`). */
const NEWEST_SESSION = "5f1c2a90-3b7e-4c1d-9a2f-7e0d4b6c8a11"

const scenario = (
	id: string,
	title: string,
	path: string,
	options: {
		readonly dataset?: string
		readonly steps?: (page: Page) => Promise<void>
		readonly faults?: Scenario["faults"]
		readonly settle?: Scenario["settle"]
	} = {},
): Scenario => ({
	id: `agent-sessions-${id}`,
	title: `Agent sessions: ${title}`,
	path,
	dataset: options.dataset ?? DATASET,
	viewports: ["desktop"],
	themes: ["light", "dark"],
	...(options.steps === undefined ? undefined : { steps: options.steps }),
	...(options.faults === undefined ? undefined : { faults: options.faults }),
	...(options.settle === undefined ? undefined : { settle: options.settle }),
	area: "agent-sessions",
})

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

const failing = (endpoint: string): Scenario["faults"] => ({
	failures: {
		[endpoint]: {
			status: 502,
			body: {
				_tag: "@maple/http/errors/WarehouseQueryError",
				message: "ui-parity: injected agent sessions failure",
			},
		},
	},
})

const held = (endpoint: string): Scenario["faults"] => ({ delays: { [endpoint]: HELD_MS } })

/** The list page's filter rail. */
const rail = (page: Page) => page.getByRole("complementary")

/** The interactions every list control gets (search, facets, ranges, toggles, reload, paging out). */
const listInteractions: ReadonlyArray<Scenario> = [
	scenario("list-search", "List, searched by session id", "/agent-sessions", {
		steps: (page) => page.getByRole("textbox", { name: "Session or trace ID…" }).fill("conv_8d"),
	}),
	scenario("list-facet", "List, an agent ticked in the rail", "/agent-sessions", {
		steps: (page) => rail(page).getByRole("checkbox", { name: "support-triage" }).click(),
	}),
	scenario("list-facet-search", "List, the tool section searched", "/agent-sessions", {
		steps: (page) => rail(page).getByRole("textbox", { name: "Search tool..." }).fill("re"),
	}),
	scenario("list-show-more", "List, the tool section expanded", "/agent-sessions", {
		steps: (page) => rail(page).getByRole("button", { name: "Show 6 more" }).click(),
	}),
	scenario("list-collapse", "List, the environment section collapsed", "/agent-sessions", {
		steps: (page) => rail(page).getByRole("button", { name: "Environment" }).click(),
	}),
	scenario("list-range-preset", "List, the Quick session length preset", "/agent-sessions", {
		steps: (page) => rail(page).getByRole("button", { name: /^Quick/ }).click(),
	}),
	scenario("list-range-typed", "List, a minimum cost typed", "/agent-sessions", {
		steps: async (page) => {
			const input = rail(page).getByRole("textbox", { name: "Minimum cost (US dollars)" })
			await input.fill("0.02")
			await input.press("Enter")
		},
	}),
	scenario("list-histogram", "List, a tokens bar clicked", "/agent-sessions", {
		steps: (page) => rail(page).getByRole("img", { name: /^Tokens distribution/ }).click(),
	}),
	scenario("list-grouped", "List, single-trace sessions hidden", "/agent-sessions", {
		// Unnamed in both apps: its `aria-labelledby` id holds spaces, so it is the rail's last checkbox.
		steps: (page) => rail(page).getByRole("checkbox").last().click(),
	}),
	scenario("list-clear-all", "List, the rail's Clear all", "/agent-sessions?agents=%5B%22researcher%22%5D", {
		steps: (page) => rail(page).getByRole("button", { name: "Clear all" }).click(),
	}),
	scenario("list-filtered-empty", "List, filtered to nothing", "/agent-sessions?agents=%5B%22nobody%22%5D"),
	scenario("list-clear-filters", "List, Clear filters on the empty list", "/agent-sessions?agents=%5B%22nobody%22%5D", {
		steps: (page) => page.getByRole("button", { name: "Clear filters" }).click(),
	}),
	scenario("list-reload", "List, reloaded", "/agent-sessions", {
		steps: (page) => page.getByRole("button", { name: "Reload" }).click(),
	}),
	scenario("list-sort-twice", "List, the cost sort flipped to ascending", "/agent-sessions", {
		steps: async (page) => {
			await page.getByRole("table").getByRole("button", { name: /^Cost/ }).click()
			await page.getByRole("table").getByRole("button", { name: /^Cost/ }).click()
		},
	}),
	scenario("list-loading", "List, the first page held", "/agent-sessions", {
		faults: held("aiSessionsInternal.list"),
		settle: "held",
	}),
	scenario("list-error", "List, the first page failing", "/agent-sessions", {
		faults: failing("aiSessionsInternal.list"),
	}),
	scenario("list-facets-error", "List, the rail's facets failing", "/agent-sessions", {
		faults: failing("aiSessionsInternal.facets"),
	}),
]

export const agentSessionsArea: AreaModule = {
	area: "agent-sessions",
	scenarios: [
		scenario("list", "List", "/agent-sessions"),
		scenario("list-empty", "List (empty org)", "/agent-sessions", { dataset: EMPTY }),
		scenario("list-with-errors", "List, with errors only", "/agent-sessions", {
			steps: (page) => page.getByRole("switch", { name: "With errors" }).click(),
		}),
		// The facet sidebar's scrollbar fades in under the pointer, so the filter is applied from
		// the URL; sorting is the in-page interaction.
		scenario(
			"list-agent-filter",
			"List, filtered to the researcher agent",
			"/agent-sessions?agents=%5B%22researcher%22%5D",
		),
		scenario("list-sort-cost", "List, sorted by cost", "/agent-sessions", {
			steps: (page) => page.getByRole("table").getByRole("button", { name: /^Cost/ }).click(),
		}),
		...listInteractions,
		scenario("detail", "Session detail", `/agent-sessions/${NEWEST_SESSION}`),
		scenario("detail-transcript", "Session detail, transcript", `/agent-sessions/${NEWEST_SESSION}`, {
			steps: (page) => page.getByRole("tab", { name: "Transcript" }).click(),
		}),
		scenario("detail-traces", "Session detail, traces", `/agent-sessions/${NEWEST_SESSION}`, {
			steps: (page) => page.getByRole("tab", { name: "Traces" }).click(),
		}),
		scenario("detail-missing", "Session detail (unknown session)", `/agent-sessions/${NEWEST_SESSION}`, {
			dataset: EMPTY,
		}),
		scenario("tools", "Tools", "/agent-sessions/tools"),
		scenario("tools-empty", "Tools (empty org)", "/agent-sessions/tools", { dataset: EMPTY }),
		scenario("tools-failing", "Tools, failing only", "/agent-sessions/tools", {
			steps: (page) => page.getByRole("button", { name: "Failing only" }).click(),
		}),
		scenario("tool-detail", "Tool detail: Bash", "/agent-sessions/tools/Bash"),
		scenario("tool-detail-empty", "Tool detail (empty org)", "/agent-sessions/tools/Bash", {
			dataset: EMPTY,
		}),
	],
}
