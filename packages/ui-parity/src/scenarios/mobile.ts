import type { Page } from "playwright"
import { chatArea } from "./chat.ts"
import { dashboardsArea } from "./dashboards.ts"
import { errorsArea } from "./errors.ts"
import { logsPageArea } from "./logs-page.ts"
import { overviewPageArea } from "./overview-page.ts"
import { servicesPageArea } from "./services-page.ts"
import { tracesPageArea } from "./traces-page.ts"
import type { AreaModule, Scenario } from "./types.ts"

/** The most used pages' loading and error states (their own faults), at the mobile width. */
const TIMED_STATES = [
	"overview-loading",
	"overview-error",
	"services-loading",
	"services-error",
	"traces-list-loading",
	"traces-list-error",
	"logs-loading",
	"logs-error",
	"errors-hub-loading",
	"errors-hub-error",
	"dashboards-view-loading",
	"chat-loading",
	"chat-history-error",
]

const timedStates: ReadonlyArray<Scenario> = [
	chatArea,
	dashboardsArea,
	errorsArea,
	logsPageArea,
	overviewPageArea,
	servicesPageArea,
	tracesPageArea,
]
	.flatMap((area) => area.scenarios)
	.filter((scenario) => TIMED_STATES.includes(scenario.id))
	.map((scenario) => ({
		...scenario,
		id: `mobile-${scenario.id}`,
		title: `Mobile: ${scenario.title}`,
		viewports: ["mobile"],
		area: "mobile",
	}))

/**
 * Pages at the mobile viewport (390 px, below `md` and `lg`): the sidebar is an off-canvas sheet
 * behind the top bar's trigger, and a page's filter rail is a left sheet behind "Open filters".
 */
const mobile = (
	id: string,
	title: string,
	path: string,
	options: Readonly<{ dataset?: string; steps?: (page: Page) => Promise<void> }> = {},
): Scenario => ({
	id: `mobile-${id}`,
	title: `Mobile: ${title}`,
	path,
	dataset: options.dataset ?? "default",
	viewports: ["mobile"],
	themes: ["light", "dark"],
	...(options.steps === undefined ? undefined : { steps: options.steps }),
	area: "mobile",
})

/** Seeded ids (as in `routes.ts` and `ops-kit.ts`, kept out of the capture side's imports). */
const ERROR_TRACE_ID = "6843a8853182b32339b2dd5120d423f2"
const TRIAGE_ISSUE_ID = "0199a004-0000-7000-8000-000000000001"
const PLATFORM_DASHBOARD = "dash_parity_ops_platform"

const openFilters = async (page: Page) => {
	await page.getByRole("button", { name: "Open filters" }).click()
	await page.getByRole("dialog", { name: "Filters" }).waitFor()
}

const openNav = async (page: Page) => {
	await page.getByRole("button", { name: "Toggle sidebar" }).first().click()
	await page.getByRole("dialog", { name: "Sidebar" }).waitFor()
}

const openTimePicker = async (page: Page) => {
	await page.getByRole("button", { name: "Last 12 hours" }).click()
	await page.getByRole("dialog").getByRole("button", { name: "Last 1 day" }).waitFor()
}

/** The pages legacy renders responsively, most used first, each with its filter sheet if it has one. */
const pages: ReadonlyArray<
	Readonly<{ id: string; title: string; path: string; filters: boolean; dataset?: string }>
> = [
	{ id: "overview", title: "Overview", path: "/", filters: false },
	{ id: "services", title: "Services", path: "/services", filters: true },
	{ id: "traces", title: "Traces", path: "/traces", filters: true },
	{ id: "logs", title: "Logs", path: "/logs", filters: true },
	{ id: "errors", title: "Errors", path: "/errors", filters: true },
	{ id: "dashboards", title: "Dashboards", path: "/dashboards", filters: false },
	{ id: "chat", title: "Chat", path: "/chat", filters: false },
	{ id: "alerts", title: "Alerts", path: "/alerts", filters: false },
	{ id: "service-map", title: "Service map", path: "/service-map", filters: false },
	{ id: "metrics", title: "Metrics", path: "/metrics", filters: false },
	{ id: "settings", title: "Settings", path: "/settings", filters: true },
	{ id: "service-detail", title: "Service detail", path: "/services/payment-svc", filters: false },
	{ id: "trace-detail", title: "Trace detail", path: `/traces/${ERROR_TRACE_ID}`, filters: false },
	{ id: "error-issue", title: "Error issue", path: `/errors/issues/${TRIAGE_ISSUE_ID}`, filters: false },
	{ id: "dashboard", title: "Dashboard", path: `/dashboards/${PLATFORM_DASHBOARD}`, filters: false },
	{ id: "infra", title: "Infrastructure", path: "/infra", filters: false, dataset: "infra-k8s" },
	{ id: "infra-hosts", title: "Hosts", path: "/infra/hosts", filters: false },
	{ id: "infra-containers", title: "Containers", path: "/infra/containers", filters: true },
	{ id: "infra-pods", title: "Kubernetes pods", path: "/infra/kubernetes/pods", filters: true, dataset: "infra-k8s" },
	{ id: "replays", title: "Replays", path: "/replays", filters: true, dataset: "acme-web" },
	{ id: "analytics", title: "Analytics", path: "/analytics", filters: true, dataset: "acme-web" },
	{ id: "releases", title: "Releases", path: "/releases", filters: true },
	{ id: "anomalies", title: "Anomalies", path: "/anomalies", filters: true },
	{ id: "investigations", title: "Investigations", path: "/investigations", filters: false },
	{ id: "agent-sessions", title: "Agent sessions", path: "/agent-sessions", filters: true, dataset: "agent-sessions" },
	{ id: "integrations", title: "Integrations", path: "/integrations", filters: true },
	{ id: "code-review", title: "Code review", path: "/code-review", filters: false, dataset: "code-review" },
]

export const mobileArea: AreaModule = {
	area: "mobile",
	scenarios: [
		...pages.flatMap((entry) => {
			const dataset = entry.dataset ?? "default"
			return [
				mobile(entry.id, entry.title, entry.path, { dataset }),
				...(entry.filters
					? [
							mobile(`${entry.id}-filters`, `${entry.title}, filter sheet open`, entry.path, {
								dataset,
								steps: openFilters,
							}),
						]
					: []),
			]
		}),
		...timedStates,
		mobile("services-empty", "Services (empty org)", "/services", { dataset: "empty" }),
		mobile("services-nav", "Services, sidebar sheet open", "/services", { steps: openNav }),
		mobile("services-time-picker", "Services, time range picker open", "/services", {
			steps: openTimePicker,
		}),
		mobile("services-org-switcher", "Services, org switcher open in the sidebar sheet", "/services", {
			steps: async (page) => {
				await openNav(page)
				await page.getByRole("button", { name: /Self Hosted/ }).click()
				await page.getByRole("menu").waitFor()
			},
		}),
		mobile("chat-switch", "Chat, conversation sheet open", "/chat", {
			steps: async (page) => {
				await page.getByRole("button", { name: "Switch conversation" }).click()
				await page.getByRole("dialog", { name: "Conversations" }).waitFor()
			},
		}),
		mobile("chat-nav", "Chat, sidebar sheet open from the chat header", "/chat", { steps: openNav }),
	],
}
