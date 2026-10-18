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
		readonly fullPage?: boolean
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
	...(options.fullPage === undefined ? undefined : { fullPage: options.fullPage }),
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
		steps: (page) =>
			rail(page)
				.getByRole("button", { name: /^Quick/ })
				.click(),
	}),
	scenario("list-range-typed", "List, a minimum cost typed", "/agent-sessions", {
		steps: async (page) => {
			const input = rail(page).getByRole("textbox", { name: "Minimum cost (US dollars)" })
			await input.fill("0.02")
			await input.press("Enter")
		},
	}),
	scenario("list-histogram", "List, a tokens bar clicked", "/agent-sessions", {
		steps: (page) =>
			rail(page)
				.getByRole("img", { name: /^Tokens distribution/ })
				.click(),
	}),
	scenario("list-histogram-drag", "List, a drag across the tokens bars held", "/agent-sessions", {
		steps: async (page) => {
			const box = await rail(page)
				.getByRole("img", { name: /^Tokens distribution/ })
				.boundingBox()
			if (box === null) return
			const y = box.y + box.height - 2
			await page.mouse.move(box.x + box.width * 0.2, y)
			await page.mouse.down()
			await page.mouse.move(box.x + box.width * 0.6, y, { steps: 4 })
		},
	}),
	scenario("list-grouped", "List, single-trace sessions hidden", "/agent-sessions", {
		// Unnamed in both apps: its `aria-labelledby` id holds spaces, so it is the rail's last checkbox.
		steps: (page) => rail(page).getByRole("checkbox").last().click(),
	}),
	scenario(
		"list-clear-all",
		"List, the rail's Clear all",
		"/agent-sessions?agents=%5B%22researcher%22%5D",
		{
			steps: (page) => rail(page).getByRole("button", { name: "Clear all" }).click(),
		},
	),
	scenario("list-filtered-empty", "List, filtered to nothing", "/agent-sessions?agents=%5B%22nobody%22%5D"),
	scenario(
		"list-clear-filters",
		"List, Clear filters on the empty list",
		"/agent-sessions?agents=%5B%22nobody%22%5D",
		{
			steps: (page) => page.getByRole("button", { name: "Clear filters" }).click(),
		},
	),
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

const TOOLS = "/agent-sessions/tools"

/** Every control of the Tools tab: search, facet selects, failing chip, tiles, percentile, sort, scope, time. */
const toolsInteractions: ReadonlyArray<Scenario> = [
	scenario("tools-search", "Tools, searched by name", TOOLS, {
		steps: (page) => page.getByRole("textbox", { name: "Tool name…" }).fill("re"),
	}),
	scenario("tools-service", "Tools, a service picked", TOOLS, {
		steps: async (page) => {
			await page.getByRole("combobox", { name: "service" }).click()
			await page.getByRole("option", { name: "support-agent" }).click()
		},
	}),
	scenario("tools-metric", "Tools, the Error rate tile picked", TOOLS, {
		steps: (page) => page.getByRole("button", { name: /^Error rate \d/ }).click(),
	}),
	scenario("tools-duration", "Tools, the Duration tile picked", TOOLS, {
		steps: (page) => page.getByRole("button", { name: "P90 duration" }).click(),
	}),
	scenario("tools-percentile", "Tools, P95 picked", TOOLS, {
		steps: (page) =>
			page.getByRole("group", { name: "Percentile" }).getByRole("button", { name: "p95" }).click(),
	}),
	scenario("tools-sort", "Tools, the table sorted by errors", TOOLS, {
		steps: (page) =>
			page.getByRole("region", { name: "Tools" }).getByRole("button", { name: "Errors" }).click(),
	}),
	scenario("tools-scope", "Tools, scoped to a tool and model", `${TOOLS}?tool=Bash&model=claude-opus-4-1`),
	scenario(
		"tools-scope-remove",
		"Tools, the tool chip removed",
		`${TOOLS}?tool=Bash&model=claude-opus-4-1`,
		{
			steps: (page) => page.getByRole("button", { name: "Remove tool Bash" }).click(),
		},
	),
	scenario("tools-scope-clear", "Tools, the scope cleared", `${TOOLS}?tool=Bash&model=claude-opus-4-1`, {
		steps: (page) => page.getByRole("button", { name: "Clear all" }).click(),
	}),
	scenario("tools-time-range", "Tools, last 1 day from the picker", TOOLS, {
		steps: async (page) => {
			await page.getByRole("button", { name: "Last 7 days" }).click()
			await page.getByRole("dialog").getByRole("button", { name: "Last 1 day" }).click()
			await page.getByRole("dialog").waitFor({ state: "detached" })
		},
	}),
	scenario("tools-reload", "Tools, reloaded", TOOLS, {
		steps: (page) => page.getByRole("button", { name: "Reload" }).click(),
	}),
	scenario("tools-chart-hover", "Tools, the chart hovered", TOOLS, {
		steps: (page) =>
			page
				.getByRole("img", { name: "Tool calls" })
				.first()
				.hover({ position: { x: 900, y: 100 } }),
	}),
	scenario("tools-loading", "Tools, the totals held", TOOLS, {
		faults: held("aiSessionsInternal.toolsTotals"),
		settle: "held",
	}),
	scenario("tools-error", "Tools, the totals failing", TOOLS, {
		faults: failing("aiSessionsInternal.toolsTotals"),
	}),
	scenario("tools-breakdowns-error", "Tools, the table's read failing", TOOLS, {
		faults: failing("aiSessionsInternal.toolsBreakdowns"),
	}),
]

const TOOL = "/agent-sessions/tools/Bash"

/** The tool detail page's controls. The error group modal (`?error=`) is not ported yet. */
const toolDetailInteractions: ReadonlyArray<Scenario> = [
	scenario("tool-detail-service", "Tool detail, a service picked", TOOL, {
		steps: async (page) => {
			await page.getByRole("combobox", { name: "service" }).click()
			await page.getByRole("option", { name: "claude-code" }).click()
		},
	}),
	scenario("tool-detail-failing", "Tool detail, failing only", TOOL, {
		steps: (page) => page.getByRole("button", { name: "Failing only" }).click(),
	}),
	scenario("tool-detail-model", "Tool detail, scoped to a model", `${TOOL}?model=claude-opus-4-1`),
	scenario(
		"tool-detail-model-remove",
		"Tool detail, the model chip removed",
		`${TOOL}?model=claude-opus-4-1`,
		{
			steps: (page) => page.getByRole("button", { name: "Remove model claude-opus-4-1" }).click(),
		},
	),
	scenario("tool-detail-sort", "Tool detail, errors sorted by sessions", TOOL, {
		steps: (page) =>
			page.getByRole("region", { name: "Errors" }).getByRole("button", { name: "Sessions" }).click(),
	}),
	scenario("tool-detail-chart-hover", "Tool detail, the calls chart hovered", TOOL, {
		steps: (page) =>
			page
				.getByRole("img", { name: "Tool calls" })
				.first()
				.hover({ position: { x: 470, y: 60 } }),
	}),
	scenario("tool-detail-time-range", "Tool detail, last 1 day from the picker", TOOL, {
		steps: async (page) => {
			await page.getByRole("button", { name: "Last 7 days" }).click()
			await page.getByRole("dialog").getByRole("button", { name: "Last 1 day" }).click()
			await page.getByRole("dialog").waitFor({ state: "detached" })
		},
	}),
	scenario("tool-detail-reload", "Tool detail, reloaded", TOOL, {
		steps: (page) => page.getByRole("button", { name: "Reload" }).click(),
	}),
	scenario("tool-detail-loading", "Tool detail, the totals held", TOOL, {
		faults: held("aiSessionsInternal.toolsTotals"),
		settle: "held",
	}),
	scenario("tool-detail-error", "Tool detail, the totals failing", TOOL, {
		faults: failing("aiSessionsInternal.toolsTotals"),
	}),
	scenario("tool-detail-errors-error", "Tool detail, the errors read failing", TOOL, {
		faults: failing("aiSessionsInternal.toolErrors"),
	}),
	scenario("tool-detail-sessions-error", "Tool detail, the sessions read failing", TOOL, {
		faults: failing("aiSessionsInternal.list"),
	}),
]

const SESSION = `/agent-sessions/${NEWEST_SESSION}`

const openView = async (page: Page, name: "Traces" | "Flow" | "Transcript") => {
	await page.getByRole("tab", { name }).click()
	await page.getByRole("tab", { name, selected: true }).waitFor()
}

const openDisplay = async (page: Page, name: "Traces" | "Flow" | "Transcript") => {
	await openView(page, name)
	await page.getByRole("button", { name: "Display options" }).click()
}

/** The failed Bash call of the newest session's first turn, and its model call. */
const BASH_SPAN = "d37d5325bf5caae9"
const CHAT_SPAN = /^chat Claude Opus 4\.1/

const openSpan = async (page: Page, name: RegExp) => {
	await openView(page, "Traces")
	await page.getByRole("button", { name }).first().click()
	await page.getByRole("dialog").waitFor()
}

/** The span inspection popover (`?span=`), the waterfall's keyboard cursor and pasted links. */
const spanInteractions: ReadonlyArray<Scenario> = [
	scenario("detail-span-open", "Session detail, a model call opened in the popover", SESSION, {
		steps: (page) => openSpan(page, CHAT_SPAN),
	}),
	scenario("detail-span-details", "Session detail, the popover's Details tab", SESSION, {
		steps: async (page) => {
			await openSpan(page, CHAT_SPAN)
			await page.getByRole("dialog").getByRole("button", { name: "Details" }).click()
		},
	}),
	scenario("detail-span-tools", "Session detail, the popover's Tool calls tab", SESSION, {
		steps: async (page) => {
			await openSpan(page, /^execute_tool Bash/)
			await page.getByRole("dialog").getByRole("button", { name: /^Tool calls/ }).click()
		},
	}),
	scenario("detail-span-logs", "Session detail, the popover's Logs tab", SESSION, {
		steps: async (page) => {
			await openSpan(page, CHAT_SPAN)
			await page.getByRole("dialog").getByRole("button", { name: "Logs" }).click()
		},
	}),
	scenario("detail-span-close", "Session detail, the popover closed", SESSION, {
		steps: async (page) => {
			await openSpan(page, CHAT_SPAN)
			await page.getByRole("button", { name: "Close span detail" }).click()
		},
	}),
	scenario("detail-span-escape", "Session detail, the popover dismissed with Escape", SESSION, {
		steps: async (page) => {
			await openSpan(page, CHAT_SPAN)
			await page.keyboard.press("Escape")
		},
	}),
	scenario("detail-span-link", "Session detail, a pasted ?span= link in Traces", `${SESSION}?view=trace&span=${BASH_SPAN}`),
	scenario(
		"detail-span-transcript-link",
		"Session detail, a pasted ?span= link in the transcript",
		`${SESSION}?view=transcript&span=${BASH_SPAN}`,
	),
	scenario("detail-span-trace-door", "Session detail, Open in Traces view from the Overview", `${SESSION}?span=${BASH_SPAN}`, {
		steps: async (page) => {
			await page.getByRole("button", { name: "Open in Traces view" }).click()
			await page.getByRole("tab", { name: "Traces", selected: true }).waitFor()
		},
	}),
	scenario("detail-traces-keys", "Session detail, the waterfall cursor moved with j and ArrowDown", SESSION, {
		steps: async (page) => {
			await openView(page, "Traces")
			await page.keyboard.press("j")
			await page.keyboard.press("j")
			await page.keyboard.press("ArrowDown")
		},
	}),
	scenario("detail-traces-keys-open", "Session detail, Enter opens the span under the cursor", SESSION, {
		steps: async (page) => {
			await openView(page, "Traces")
			// Off the tab: Enter on a focused button is the button's, not the cursor's.
			await page.getByText(/^Axis shows active time/).click()
			await page.keyboard.press("j")
			await page.keyboard.press("k")
			await page.keyboard.press("j")
			await page.keyboard.press("Enter")
			await page.getByRole("dialog").waitFor()
		},
	}),
]

/** The session page's controls, the span popover's among them. */
const detailInteractions: ReadonlyArray<Scenario> = [
	scenario("detail-flow", "Session detail, flow", SESSION, { steps: (page) => openView(page, "Flow") }),
	scenario("detail-hotkey", "Session detail, the 2 key opens Traces", SESSION, {
		steps: (page) => page.keyboard.press("2"),
	}),
	scenario("detail-ledger", "Session detail, a tool ledger row opened", SESSION, {
		steps: (page) => page.getByRole("button", { name: "Bash", exact: true }).click(),
	}),
	scenario("detail-checks-passed", "Session detail, the passed checks opened", SESSION, {
		steps: (page) => page.getByRole("button", { name: /^Passed/ }).click(),
	}),
	scenario("detail-checks-skipped", "Session detail, the unchecked checks opened", SESSION, {
		steps: (page) => page.getByRole("button", { name: /^Not checked/ }).click(),
	}),
	scenario("detail-open-tools", "Session detail, the Tools section link", SESSION, {
		steps: (page) => page.getByRole("button", { name: "Tools section" }).click(),
	}),
	scenario("detail-traces-filter", "Session detail, traces filtered", SESSION, {
		steps: async (page) => {
			await openView(page, "Traces")
			await page.getByRole("textbox", { name: "Filter spans" }).fill("Bash")
		},
	}),
	scenario("detail-traces-display", "Session detail, the traces Display options", SESSION, {
		steps: (page) => openDisplay(page, "Traces"),
	}),
	scenario("detail-traces-idle", "Session detail, traces with idle kept", SESSION, {
		steps: async (page) => {
			await openDisplay(page, "Traces")
			await page.getByRole("switch", { name: "Collapse idle" }).click()
		},
	}),
	scenario("detail-traces-all-spans", "Session detail, traces with app spans", SESSION, {
		steps: async (page) => {
			await openDisplay(page, "Traces")
			await page.getByRole("switch", { name: "Agent spans only" }).click()
		},
	}),
	scenario("detail-traces-collapse", "Session detail, a trace turn collapsed", SESSION, {
		steps: async (page) => {
			await openView(page, "Traces")
			await page.getByRole("button", { name: /^Turn 1/ }).click()
		},
	}),
	scenario("detail-transcript-filter", "Session detail, transcript filtered", SESSION, {
		steps: async (page) => {
			await openView(page, "Transcript")
			await page.getByRole("textbox", { name: "Filter transcript" }).fill("retry")
		},
	}),
	scenario("detail-transcript-payloads", "Session detail, transcript payloads expanded", SESSION, {
		steps: async (page) => {
			await openDisplay(page, "Transcript")
			await page.getByRole("switch", { name: "Expand tool payloads" }).click()
			await page.keyboard.press("Escape")
		},
	}),
	scenario("detail-transcript-tool", "Session detail, a transcript tool card opened", SESSION, {
		steps: async (page) => {
			await openView(page, "Transcript")
			await page.getByRole("button", { name: /^Grep \d/ }).click()
		},
	}),
	scenario("detail-transcript-system", "Session detail, a system prompt opened", SESSION, {
		steps: async (page) => {
			await openView(page, "Transcript")
			await page
				.getByRole("button", { name: /^System prompt/ })
				.first()
				.click()
		},
	}),
	scenario("detail-transcript-raw", "Session detail, a message shown raw", SESSION, {
		steps: async (page) => {
			await openView(page, "Transcript")
			await page.getByRole("button", { name: "raw" }).first().click({ force: true })
		},
	}),
	scenario("detail-transcript-collapse", "Session detail, a transcript turn collapsed", SESSION, {
		steps: async (page) => {
			await openView(page, "Transcript")
			await page
				.getByRole("heading", { name: /^Turn 1/ })
				.getByRole("button")
				.click()
		},
	}),
	...spanInteractions,
	scenario("detail-flow-merge", "Session detail, flow with repeats merged", SESSION, {
		steps: async (page) => {
			await openDisplay(page, "Flow")
			await page.getByRole("switch", { name: "Merge repeat tools" }).click()
			await page.keyboard.press("Escape")
		},
	}),
	scenario("detail-flow-zoom", "Session detail, flow zoomed in", SESSION, {
		steps: async (page) => {
			await openView(page, "Flow")
			await page.getByRole("button", { name: "Zoom in" }).click()
		},
	}),
	scenario("detail-loading", "Session detail, the spans held", SESSION, {
		faults: held("aiSessionsInternal.spans"),
		settle: "held",
	}),
	scenario("detail-error", "Session detail, the spans failing", SESSION, {
		faults: failing("aiSessionsInternal.spans"),
	}),
]

const labVariant = (
	id: string,
	title: string,
	path: string,
	steps?: (page: Page) => Promise<void>,
): Scenario => ({
	id,
	title: `Lab: ${title}`,
	path,
	dataset: "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	area: "lab",
	...(steps === undefined ? undefined : { steps }),
})

/** The agent labs' controls. Not exercised: `/lab/agent-tools`' detail view, which is not ported. */
const labInteractions: ReadonlyArray<Scenario> = [
	labVariant("lab-agent-session-clean", "Agent session, the clean fixture", "/lab/agent-session", (page) =>
		page.getByRole("button", { name: "Clean" }).click(),
	),
	labVariant("lab-agent-session-capture-off", "Agent session, capture off", "/lab/agent-session", (page) =>
		page.getByRole("button", { name: "Capture off" }).click(),
	),
	labVariant(
		"lab-agent-session-transcript",
		"Agent session, opened on the transcript",
		"/lab/agent-session?view=transcript",
	),
	labVariant("lab-agent-sessions-width", "Agent sessions list at 700px", "/lab/agent-sessions", (page) =>
		page.getByRole("button", { name: "700px" }).click(),
	),
	labVariant(
		"lab-agent-sessions-sort",
		"Agent sessions list, sorted by cost",
		"/lab/agent-sessions",
		(page) => page.getByRole("table").getByRole("button", { name: /^Cost/ }).click(),
	),
	labVariant(
		"lab-agent-sessions-errors",
		"Agent sessions list, with errors",
		"/lab/agent-sessions",
		(page) => page.getByRole("switch", { name: "With errors" }).click(),
	),
	labVariant("lab-agent-tools-width", "Agent tools at 820px", "/lab/agent-tools", (page) =>
		page.getByRole("button", { name: "820px" }).click(),
	),
	labVariant("lab-agent-tools-failing", "Agent tools, failing only", "/lab/agent-tools", (page) =>
		page.getByRole("button", { name: "Failing only" }).click(),
	),
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
		...toolsInteractions,
		...toolDetailInteractions,
		...detailInteractions,
		...labInteractions,
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
