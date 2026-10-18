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
	steps,
	area: "onboarding",
})

const click = (name: string | RegExp) => (page: Page) => page.getByRole("button", { name }).click()

/**
 * The MCP client's callback answers 204, so Chromium keeps the consent page (the harness would
 * abort the off-origin navigation into an error page): the capture is the state up to the redirect.
 */
const decideMcp = (name: string) => async (page: Page) => {
	await page.route("https://claude.ai/**", (route) => route.fulfill({ status: 204 }))
	await click(name)(page)
}

const HELD_MS = 60_000

const failure = (status: number, tag: string, message: string) => ({
	status,
	body: { _tag: `@maple/http/errors/${tag}`, message },
})

/** Loading and error states: a held or failing request (README "Timed and error states"). */
const timed = (
	base: Scenario,
	id: string,
	title: string,
	faults: NonNullable<Scenario["faults"]>,
	// A request held after a click: "held" would also wait before the click, with nothing in flight.
	settle: Scenario["settle"] = faults.delays === undefined ? "quiet" : "held",
): Scenario => ({ ...base, id: `onboarding-${id}`, title, faults, settle })

const cliDevice = scenario("cli-login-device", "", `/cli-login?user_code=${CLI_USER_CODE}`, "default")
const mcpConsent = scenario("mcp-authorize", "", `/mcp-authorize?request_id=${MCP_REQUEST_ID}`, "default")
const unsubscribeConfirm = scenario(
	"unsubscribe",
	"",
	"/unsubscribe?token=digest.parity-token",
	"default",
	click("Unsubscribe"),
)

const timedScenarios: ReadonlyArray<Scenario> = [
	timed(cliDevice, "cli-login-loading", "CLI login: inspecting the code", {
		delays: { "auth.cliDeviceInspect": HELD_MS },
	}),
	timed(
		{ ...cliDevice, steps: click("Approve") },
		"cli-login-approve-error",
		"CLI login: approval refused",
		{
			failures: {
				"auth.cliDeviceApprove": failure(409, "CliDeviceConflictError", "This CLI login was already used."),
			},
		},
	),
	timed(mcpConsent, "mcp-authorize-loading", "MCP authorize: inspecting the request", {
		delays: { "auth.mcpOAuthAuthorizationInspect": HELD_MS },
	}),
	timed(
		unsubscribeConfirm,
		"unsubscribe-pending",
		"Unsubscribe: request in flight",
		{ delays: { "emailPublic.unsubscribe": HELD_MS } },
		"quiet",
	),
	timed(unsubscribeConfirm, "unsubscribe-invalid-token", "Unsubscribe: token rejected", {
		failures: {
			"emailPublic.unsubscribe": failure(400, "DigestUnsubscribeTokenInvalidError", "Invalid token"),
		},
	}),
	timed(unsubscribeConfirm, "unsubscribe-error", "Unsubscribe: server error", {
		failures: { "emailPublic.unsubscribe": failure(503, "DigestPersistenceError", "Unavailable") },
	}),
]

export const onboardingArea: AreaModule = {
	area: "onboarding",
	scenarios: [
		scenario("cli-login-entry", "CLI login: code entry", "/cli-login", "default"),
		scenario(
			"cli-login-device",
			"CLI login: device to approve",
			`/cli-login?user_code=${CLI_USER_CODE}`,
			"default",
		),
		scenario(
			"cli-login-approved",
			"CLI login: approved",
			`/cli-login?user_code=${CLI_USER_CODE}`,
			"default",
			click("Approve"),
		),
		scenario(
			"cli-login-denied",
			"CLI login: denied",
			`/cli-login?user_code=${CLI_USER_CODE}`,
			"default",
			click("Deny"),
		),
		scenario("cli-login-invalid", "CLI login: unknown code", "/cli-login?user_code=ZZZZ-ZZZZ", "default"),
		scenario(
			"cli-login-clerk",
			"CLI login: Clerk workspace",
			`/cli-login?user_code=${CLI_USER_CODE}`,
			"clerk-acme",
		),
		scenario(
			"mcp-authorize",
			"MCP authorize: consent",
			`/mcp-authorize?request_id=${MCP_REQUEST_ID}`,
			"default",
		),
		scenario(
			"mcp-authorize-approved",
			"MCP authorize: approved, returning to the client",
			`/mcp-authorize?request_id=${MCP_REQUEST_ID}`,
			"default",
			decideMcp("Approve"),
		),
		scenario(
			"mcp-authorize-denied",
			"MCP authorize: denied, returning to the client",
			`/mcp-authorize?request_id=${MCP_REQUEST_ID}`,
			"default",
			decideMcp("Deny"),
		),
		scenario("mcp-authorize-incomplete", "MCP authorize: incomplete link", "/mcp-authorize", "default"),
		scenario(
			"mcp-authorize-used",
			"MCP authorize: already used",
			`/mcp-authorize?request_id=${MCP_USED_REQUEST_ID}`,
			"default",
		),
		scenario(
			"mcp-authorize-clerk",
			"MCP authorize: Clerk workspace",
			`/mcp-authorize?request_id=${MCP_REQUEST_ID}`,
			"clerk-acme",
		),
		scenario("unsubscribe", "Unsubscribe: confirm", "/unsubscribe?token=digest.parity-token", "default"),
		scenario(
			"unsubscribe-done",
			"Unsubscribe: done",
			"/unsubscribe?token=digest.parity-token",
			"default",
			click("Unsubscribe"),
		),
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
		{
			...scenario(
				"select-plan-lapsed",
				"Select plan: lapsed subscriber",
				"/select-plan",
				"clerk-lapsed",
			),
			fullPage: true,
		},
		scenario("org-required", "Organization required", "/org-required", "clerk-no-org"),
		scenario(
			"org-required-menu",
			"Organization required: switcher open",
			"/org-required",
			"clerk-no-org",
			click("Select or create organization"),
		),
		scenario("sign-up", "Sign up (signed out)", "/sign-up", "clerk-signed-out"),
		...timedScenarios,
	],
}
