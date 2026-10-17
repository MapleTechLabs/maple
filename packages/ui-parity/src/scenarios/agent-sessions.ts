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
	options: { readonly dataset?: string; readonly steps?: (page: Page) => Promise<void> } = {},
): Scenario => ({
	id: `agent-sessions-${id}`,
	title: `Agent sessions: ${title}`,
	path,
	dataset: options.dataset ?? DATASET,
	viewports: ["desktop"],
	themes: ["light", "dark"],
	...(options.steps === undefined ? undefined : { steps: options.steps }),
	area: "agent-sessions",
})

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
		scenario("list-agent-filter", "List, filtered to the researcher agent", "/agent-sessions?agents=%5B%22researcher%22%5D"),
		scenario("list-sort-cost", "List, sorted by cost", "/agent-sessions", {
			steps: (page) => page.getByRole("table").getByRole("button", { name: /^Cost/ }).click(),
		}),
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
		scenario("tool-detail-empty", "Tool detail (empty org)", "/agent-sessions/tools/Bash", { dataset: EMPTY }),
	],
}
