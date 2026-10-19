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

/** Role, then one intent, to the team step. */
const toTeamStep = async (page: Page) => {
	await page.getByText("Backend engineer", { exact: true }).click()
	await page.getByRole("button", { name: /Continue/ }).click()
	await page.getByText("Traces", { exact: true }).click()
	await page.getByRole("button", { name: "Continue", exact: true }).click()
	await page.getByText("Bring your team").waitFor()
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

/** `/lab/onboarding`, the sessionless preview: later steps, the simulated team and checkout. */
const lab = (id: string, title: string, path: string, steps?: (page: Page) => Promise<void>): Scenario => ({
	id: `onboarding-lab-${id}`,
	title: `Onboarding lab: ${title}`,
	path,
	viewports: ["desktop"],
	themes: ["light", "dark"],
	steps,
	area: "onboarding",
})

const labScenarios: ReadonlyArray<Scenario> = [
	lab("team-renamed", "workspace renamed and a teammate invited", "/lab/onboarding?step=3", async (page) => {
		await page.getByLabel("Workspace name").fill("Orbit Labs")
		await click("Save name")(page)
		await page.getByText("Workspace name saved. Make yourself at home.").waitFor()
		await page.getByLabel(/Invite a teammate/).fill("grace@orbit.test")
		await click("Send invitation")(page)
		await page.getByText("Invitation sent to grace@orbit.test.").waitFor()
	}),
	{ ...lab("plan", "sample plans", "/lab/onboarding?step=4"), fullPage: true },
	lab("complete", "checkout simulated", "/lab/onboarding?step=4", click("Start 14-day trial")),
	lab("restart", "restarted from the plans", "/lab/onboarding?step=4", click("Restart")),
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
			"cli-login-clerk-switcher",
			"CLI login: Clerk workspace switcher open",
			`/cli-login?user_code=${CLI_USER_CODE}`,
			"clerk-acme",
			click("Switch"),
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
		scenario("quick-start-account-menu", "Quick start: account menu open", "/quick-start", "clerk", click("Account menu")),
		scenario("quick-start-org-menu", "Quick start: org switcher open", "/quick-start", "clerk", click(/Orbit Labs/)),
		scenario("quick-start-intent-picked", "Quick start: intents chosen", "/quick-start", "clerk", async (page) => {
			await page.getByText("Backend engineer", { exact: true }).click()
			await page.getByRole("button", { name: /Continue/ }).click()
			await page.getByText("Traces", { exact: true }).click()
			await page.getByText("Logs", { exact: true }).click()
		}),
		scenario("quick-start-team", "Quick start: team step", "/quick-start", "clerk", toTeamStep),
		scenario("quick-start-team-invited", "Quick start: teammate invited", "/quick-start", "clerk", async (page) => {
			await toTeamStep(page)
			await page.getByLabel(/Invite a teammate/).fill("grace@orbit.test")
			await click("Send invitation")(page)
			await page.getByText("Invitation sent to grace@orbit.test.").waitFor()
		}),
		{
			...scenario("quick-start-plan", "Quick start: plan step", "/quick-start", "clerk", async (page) => {
				await toTeamStep(page)
				await click("Continue to plans")(page)
			}),
			fullPage: true,
		},
		{ ...scenario("select-plan", "Select plan: free trial", "/select-plan", "clerk"), fullPage: true },
		{
			...scenario("select-plan-trial-start", "Select plan: trial started, leaving for Stripe", "/select-plan", "clerk", async (page) => {
				await page.route("https://checkout.stripe.com/**", (route) => route.fulfill({ status: 204 }))
				await click("Start 14-day trial")(page)
			}),
			fullPage: true,
		},
		{
			...scenario(
				"select-plan-lapsed",
				"Select plan: lapsed subscriber",
				"/select-plan",
				"clerk-lapsed",
			),
			fullPage: true,
		},
		scenario("wrong-region", "Wrong region: an EU organization on the US dashboard", "/", "clerk-eu"),
		scenario(
			"wrong-region-menu",
			"Wrong region: organization switcher open",
			"/",
			"clerk-eu",
			click("Switch organization"),
		),
		scenario("org-required", "Organization required", "/org-required", "clerk-no-org"),
		scenario(
			"org-required-menu",
			"Organization required: switcher open",
			"/org-required",
			"clerk-no-org",
			click("Select or create organization"),
		),
		scenario("sign-up", "Sign up (signed out)", "/sign-up", "clerk-signed-out"),
		scenario("sign-in-clerk", "Clerk sign in (signed out)", "/sign-in", "clerk-signed-out"),
		scenario("sign-in-clerk-preview", "Clerk sign in: PR preview access form", "/sign-in", "clerk-preview"),
		timed(
			scenario("sign-in-clerk-preview-rejected", "", "/sign-in", "clerk-preview", async (page) => {
				await page.getByLabel("Access key").fill("wrong-key")
				await click("Sign in to preview")(page)
				await page.getByRole("alert").waitFor()
			}),
			"sign-in-clerk-preview-rejected",
			"Clerk sign in: PR preview key rejected",
			{
				failures: {
					"authPublic.previewSignIn$": failure(
						401,
						"PreviewSignInInvalidKeyError",
						"That preview access key is not valid.",
					),
				},
			},
		),
		...timedScenarios,
		...labScenarios,
	],
}
