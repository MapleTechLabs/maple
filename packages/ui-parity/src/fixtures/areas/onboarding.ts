import { Effect, Predicate } from "effect"
import {
	CliDeviceNotFoundError,
	McpOAuthAuthorizationNotFoundError,
} from "@maple/domain/http"
import type { FixtureArea } from "../areas.ts"
import type { Dataset, EndpointHandler } from "../dataset.ts"
import { acmeAdmin, DAY, FROZEN_NOW, FROZEN_NOW_MS, MINUTE } from "../identity.ts"
import type { DatasetIdentity } from "../../contract.ts"
import { emptyTelemetry } from "../telemetry/rows.ts"

/**
 * Pre-app flows: CLI device login and MCP OAuth consent (self-hosted `default`), plus Clerk-only
 * onboarding, plan selection, org selection and sign-up on their own Clerk datasets.
 */

export const CLI_USER_CODE = "WDJB-MJHT"
export const MCP_REQUEST_ID = "mcpreq_parity_pending"
export const MCP_USED_REQUEST_ID = "mcpreq_parity_used"

const field = (value: unknown, key: string): string =>
	Predicate.hasProperty(value, key) && typeof value[key] === "string" ? value[key] : ""

const expiresAt = new Date(FROZEN_NOW_MS + 10 * MINUTE).toISOString()

const cliDeviceInspect: EndpointHandler = ({ params }) => {
	const userCode = field(params, "userCode")
	return userCode === CLI_USER_CODE
		? Effect.succeed({
				userCode,
				deviceName: "Maple CLI on ada-macbook-pro",
				expiresAt,
				status: "pending",
			})
		: Effect.fail(new CliDeviceNotFoundError({ message: "This CLI login code is invalid or expired." }))
}

const mcpInspect: EndpointHandler = ({ params }) => {
	const requestId = field(params, "requestId")
	if (requestId !== MCP_REQUEST_ID && requestId !== MCP_USED_REQUEST_ID)
		return Effect.fail(
			new McpOAuthAuthorizationNotFoundError({
				message: "This MCP authorization request is invalid or expired.",
			}),
		)
	return Effect.succeed({
		clientName: "Claude",
		redirectUri: "https://claude.ai/api/mcp/auth_callback",
		resource: "https://api.maple.dev/mcp",
		scopes: ["mcp"],
		expiresAt,
		status: requestId === MCP_REQUEST_ID ? "pending" : "used",
	})
}

const usagePrice = (amount: number, billingUnits = 1) => ({ amount, billingUnits, interval: "month" })

/** The live Autumn catalog shape (`apps/api/autumn.config.ts`): Startup plus two add-ons. */
const plans = (trialAvailable: boolean) => ({
	plans: [
		{
			id: "startup",
			name: "Startup",
			description: null,
			price: { amount: 39, interval: "month" },
			items: [
				{ featureId: "logs", included: 100, price: usagePrice(0.3), feature: { name: "Logs" } },
				{ featureId: "metrics", included: 100, price: usagePrice(0.3), feature: { name: "Metrics" } },
				{ featureId: "traces", included: 100, price: usagePrice(0.3), feature: { name: "Traces" } },
				{
					featureId: "browser_sessions",
					included: 5000,
					price: usagePrice(0.002),
					feature: { name: "Browser Sessions" },
				},
				{
					featureId: "product_events",
					included: 1_000_000,
					price: usagePrice(0.005, 1000),
					feature: { name: "Product Events" },
				},
				{
					featureId: "ai_credits",
					included: 10,
					price: usagePrice(1),
					feature: { name: "AI Credits" },
				},
			],
			customerEligibility: { status: null, attachAction: "activate", trialAvailable },
			freeTrial: { durationLength: 14 },
		},
		{
			id: "bringyourowncloud",
			name: "Bring Your Own Cloud",
			addOn: true,
			price: { amount: 0, interval: "month" },
			items: [{ featureId: "bringyourowncloud", included: 1 }],
		},
	],
})

const newCustomer =
	(identity: DatasetIdentity): EndpointHandler =>
	() =>
		Effect.succeed({ id: identity.orgId, subscriptions: [] })

/** An active Startup subscription, past due or with metered balances. */
const activeCustomer =
	(
		identity: DatasetIdentity,
		options: { readonly pastDue?: boolean; readonly balances?: Readonly<Record<string, unknown>> },
	): EndpointHandler =>
	() =>
		Effect.succeed({
			id: identity.orgId,
			subscriptions: [
				{
					planId: "startup",
					plan: { id: "startup", name: "Startup" },
					status: "active",
					pastDue: options.pastDue ?? false,
					currentPeriodStart: FROZEN_NOW_MS - 10 * DAY,
					currentPeriodEnd: FROZEN_NOW_MS + 20 * DAY,
				},
			],
			...(options.balances === undefined ? {} : { balances: options.balances }),
		})

/** A Startup subscription that expired a week ago: the reactivation framing. */
const lapsedCustomer =
	(identity: DatasetIdentity): EndpointHandler =>
	() =>
		Effect.succeed({
			id: identity.orgId,
			subscriptions: [
				{
					planId: "startup",
					status: "expired",
					currentPeriodStart: FROZEN_NOW_MS - 37 * DAY,
					currentPeriodEnd: FROZEN_NOW_MS - 7 * DAY,
				},
			],
		})

const step = (id: string, title: string, href: string, completed: boolean, optional = false) => ({
	object: "onboarding_checklist_step",
	id,
	title,
	completed,
	href,
	optional,
})

/** The onboarding reward checklist (`GET /v2/onboarding/checklist`): one of four steps done. */
const checklist = (status: "in_progress" | "claimable" | "claimed") => {
	const isDone = status !== "in_progress"
	return {
		object: "onboarding_checklist",
		status,
		reward_amount_usd: 30,
		deadline_at: new Date(FROZEN_NOW_MS + 20 * 60 * MINUTE).toISOString(),
		claimed_at: status === "claimed" ? FROZEN_NOW : null,
		completed_count: isDone ? 4 : 1,
		total_count: 4,
		steps: [
			step("send_telemetry", "Send your first telemetry", "/settings?tab=ingestion", true),
			step("connect_github", "Connect GitHub", "/integrations?integration=github", isDone),
			step("create_alert_rule", "Create an alert with a destination", "/alerts", isDone),
			step("connect_mcp_agent", "Connect an MCP agent", "/settings?tab=mcp", isDone),
			step("invite_teammate", "Invite a teammate", "/settings?tab=members", false, true),
			step("join_slack_channel", "Join a shared Slack channel", "/?support=slack_channel", false, true),
		],
	}
}

const supportChannel = (status: "not_created" | "active", invitedEmail: string | null) => ({
	object: "support_channel",
	status,
	channel_name: status === "active" ? "maple-acme" : null,
	slack_url: status === "active" ? "https://slack.com/app_redirect?channel=C0PARITY" : null,
	created_at: status === "active" ? FROZEN_NOW : null,
	invited_email: invitedEmail,
})

/** A Clerk sign-up whose organization has no plan yet: the onboarding wizard and plan picker. */
const orbitAdmin: DatasetIdentity = {
	orgId: "org_parity_orbit",
	userId: "user_parity_margaret",
	email: "margaret@orbit.test",
	name: "Margaret Hamilton",
	orgName: "Orbit Labs",
	orgSlug: "orbit-labs",
	role: "admin",
}

/** An empty `orgSlug` tells the Clerk stub the user has no active organization. */
const orglessUser: DatasetIdentity = { ...orbitAdmin, orgId: "org_parity_orgless", orgName: "", orgSlug: "" }

const clerkDataset = (
	name: string,
	identity: DatasetIdentity | null,
	endpoints: Readonly<Record<string, EndpointHandler>> = {},
): Dataset => ({
	name,
	now: FROZEN_NOW,
	identity,
	auth: "clerk",
	endpoints,
	synced: {},
	telemetry: emptyTelemetry,
})

const attachCheckout = () => Effect.succeed({ paymentUrl: "https://checkout.stripe.com/c/pay/cs_parity" })

export const fixtureArea: FixtureArea = {
	area: "onboarding",
	endpoints: () => ({
		"auth.cliDeviceInspect": cliDeviceInspect,
		"auth.cliDeviceApprove": () => Effect.succeed({ status: "approved" }),
		"auth.cliDeviceDeny": () => Effect.succeed({ status: "denied" }),
		"auth.mcpOAuthAuthorizationInspect": mcpInspect,
		// Off-origin redirects back to the client: the harness aborts them, so the call is what counts.
		"auth.mcpOAuthAuthorizationApprove": () =>
			Effect.succeed({
				status: "approved",
				redirectUri: "https://claude.ai/api/mcp/auth_callback?code=parity-code",
			}),
		"auth.mcpOAuthAuthorizationDeny": () =>
			Effect.succeed({
				status: "denied",
				redirectUri: "https://claude.ai/api/mcp/auth_callback?error=access_denied",
			}),
		// The Clerk top bar's reward pill: in progress, and claimed once an admin claims it.
		"onboardingChecklist.retrieve": () => Effect.succeed(checklist("in_progress")),
		"onboardingChecklist.claim": () => Effect.succeed(checklist("claimed")),
		// The Clerk org switcher's create dialog: the server creates the org with its region.
		"organizationCreation.create": () => Effect.succeed({ orgId: "org_parity_created", region: "us" }),
		// The Clerk Support menu's shared Slack channel: none yet; the button creates it and invites.
		"supportChannel.retrieve": () => Effect.succeed(supportChannel("not_created", null)),
		"supportChannel.invite": () => Effect.succeed(supportChannel("active", "ada@acme.test")),
		"emailPublic.unsubscribe": ({ query }) =>
			Effect.succeed({
				kind: field(query, "token").startsWith("web-analytics.") ? "web-analytics" : "digest",
			}),
	}),
	datasets: [
		clerkDataset("clerk", orbitAdmin, {
			"billing.getCustomer": newCustomer(orbitAdmin),
			// Autumn answers a new subscription with Stripe Checkout; the harness keeps the page (204).
			// Dataset-scoped: the settings area answers `billing.attach` for its plan switch.
			"billing.attach": attachCheckout,
			"billingPublic.listPlans": () => Effect.succeed(plans(true)),
		}),
		clerkDataset("clerk-lapsed", orbitAdmin, {
			// A returning subscriber is not trial-eligible.
			"billing.getCustomer": lapsedCustomer(orbitAdmin),
			"billing.attach": attachCheckout,
			"billingPublic.listPlans": () => Effect.succeed(plans(false)),
		}),
		// Acme on Clerk with the generic Startup customer: an org already in the app.
		clerkDataset("clerk-acme", acmeAdmin),
		// Acme with the `releases` rollout on in its Clerk metadata: the Releases nav row.
		clerkDataset("clerk-flags", { ...acmeAdmin, orgPublicMetadata: { releases: true } }),
		// Acme whose last invoice failed: the payment banner and its customer portal.
		clerkDataset("clerk-past-due", acmeAdmin, {
			"billing.getCustomer": activeCustomer(acmeAdmin, { pastDue: true }),
			"billing.openCustomerPortal": () => Effect.succeed({ url: "https://billing.stripe.com/p/session/parity" }),
		}),
		// Acme at 85% of its included logs: the dismissible usage banner.
		clerkDataset("clerk-quota", acmeAdmin, {
			"billing.getCustomer": activeCustomer(acmeAdmin, {
				balances: { logs: { granted: 100, usage: 85, unlimited: false, overageAllowed: false } },
			}),
		}),
		// Acme with every checklist step done: the pill offers the credit.
		clerkDataset("clerk-reward", acmeAdmin, {
			"onboardingChecklist.retrieve": () => Effect.succeed(checklist("claimable")),
		}),
		clerkDataset("clerk-no-org", orglessUser),
		clerkDataset("clerk-signed-out", null),
		// A PR preview deploy: Clerk's sign-in plus the shared reviewer's access-key form.
		clerkDataset("clerk-preview", null, {
			"authPublic.previewSignInStatus": () => Effect.succeed({ enabled: true }),
			// A rejected key is a scenario fault (`onboarding-sign-in-clerk-preview-rejected`).
			"authPublic.previewSignIn": () => Effect.succeed({ ticket: "parity-ticket" }),
		}),
	],
}
