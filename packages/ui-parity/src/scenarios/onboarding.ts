import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * Pre-app flows. CLI login, MCP consent and unsubscribe run on self-hosted `default`; onboarding,
 * plan selection, org selection and sign-up exist only with Clerk, on the onboarding area's Clerk datasets.
 */

// Ids the onboarding fixtures answer (src/fixtures/areas/onboarding.ts).
const CLI_USER_CODE = "WDJB-MJHT"
const MCP_REQUEST_ID = "mcpreq_parity_pending"
const MCP_USED_REQUEST_ID = "mcpreq_parity_used"

const scenario = (
	id: string,
	title: string,
	path: string,
	dataset: string,
	steps?: (page: Page) => Promise<void>,
): Scenario => ({
	id: `onboarding-${id}`,
	title,
	path,
	dataset,
	viewports: ["desktop"],
	themes: ["light", "dark"],
	...(steps === undefined ? {} : { steps }),
	area: "onboarding",
})

const click = (name: string | RegExp) => (page: Page) => page.getByRole("button", { name }).click()

export const onboardingArea: AreaModule = {
	area: "onboarding",
	scenarios: [
		scenario("cli-login-entry", "CLI login: code entry", "/cli-login", "default"),
		scenario("cli-login-device", "CLI login: device to approve", `/cli-login?user_code=${CLI_USER_CODE}`, "default"),
		scenario(
			"cli-login-approved",
			"CLI login: approved",
			`/cli-login?user_code=${CLI_USER_CODE}`,
			"default",
			click("Approve"),
		),
		scenario("cli-login-denied", "CLI login: denied", `/cli-login?user_code=${CLI_USER_CODE}`, "default", click("Deny")),
		scenario("cli-login-invalid", "CLI login: unknown code", "/cli-login?user_code=ZZZZ-ZZZZ", "default"),
		scenario("cli-login-clerk", "CLI login: Clerk workspace", `/cli-login?user_code=${CLI_USER_CODE}`, "clerk-acme"),
		scenario("mcp-authorize", "MCP authorize: consent", `/mcp-authorize?request_id=${MCP_REQUEST_ID}`, "default"),
		scenario("mcp-authorize-incomplete", "MCP authorize: incomplete link", "/mcp-authorize", "default"),
		scenario("mcp-authorize-used", "MCP authorize: already used", `/mcp-authorize?request_id=${MCP_USED_REQUEST_ID}`, "default"),
		scenario("mcp-authorize-clerk", "MCP authorize: Clerk workspace", `/mcp-authorize?request_id=${MCP_REQUEST_ID}`, "clerk-acme"),
		scenario("unsubscribe", "Unsubscribe: confirm", "/unsubscribe?token=digest.parity-token", "default"),
		scenario("unsubscribe-done", "Unsubscribe: done", "/unsubscribe?token=digest.parity-token", "default", click("Unsubscribe")),
		scenario("unsubscribe-invalid", "Unsubscribe: missing token", "/unsubscribe", "default"),
		scenario("quick-start", "Quick start: role step", "/quick-start", "clerk"),
		scenario("quick-start-role-picked", "Quick start: role chosen", "/quick-start", "clerk", (page) =>
			page.getByText("Backend engineer", { exact: true }).click(),
		),
		scenario("quick-start-intent", "Quick start: intent step", "/quick-start", "clerk", async (page) => {
			await page.getByText("DevOps / SRE / Platform", { exact: true }).click()
			await page.getByRole("button", { name: /Continue/ }).click()
		}),
		{ ...scenario("select-plan", "Select plan: free trial", "/select-plan", "clerk"), fullPage: true },
		{ ...scenario("select-plan-lapsed", "Select plan: lapsed subscriber", "/select-plan", "clerk-lapsed"), fullPage: true },
		scenario("org-required", "Organization required", "/org-required", "clerk-no-org"),
		scenario("org-required-menu", "Organization required: switcher open", "/org-required", "clerk-no-org", click("Select or create organization")),
		scenario("sign-up", "Sign up (signed out)", "/sign-up", "clerk-signed-out"),
	],
}
