import { Effect, Predicate } from "effect"
import { CliDeviceNotFoundError, McpOAuthAuthorizationNotFoundError } from "@maple/domain/http"
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
		? Effect.succeed({ userCode, deviceName: "Maple CLI on ada-macbook-pro", expiresAt, status: "pending" })
		: Effect.fail(new CliDeviceNotFoundError({ message: "This CLI login code is invalid or expired." }))
}

const mcpInspect: EndpointHandler = ({ params }) => {
	const requestId = field(params, "requestId")
	if (requestId !== MCP_REQUEST_ID && requestId !== MCP_USED_REQUEST_ID)
		return Effect.fail(
			new McpOAuthAuthorizationNotFoundError({ message: "This MCP authorization request is invalid or expired." }),
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
				{ featureId: "browser_sessions", included: 5000, price: usagePrice(0.002), feature: { name: "Browser Sessions" } },
				{ featureId: "product_events", included: 1_000_000, price: usagePrice(0.005, 1000), feature: { name: "Product Events" } },
				{ featureId: "ai_credits", included: 10, price: usagePrice(1), feature: { name: "AI Credits" } },
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

const newCustomer = (identity: DatasetIdentity): EndpointHandler => () =>
	Effect.succeed({ id: identity.orgId, subscriptions: [] })

/** A Startup subscription that expired a week ago: the reactivation framing. */
const lapsedCustomer = (identity: DatasetIdentity): EndpointHandler => () =>
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

export const fixtureArea: FixtureArea = {
	area: "onboarding",
	endpoints: () => ({
		"auth.cliDeviceInspect": cliDeviceInspect,
		"auth.cliDeviceApprove": () => Effect.succeed({ status: "approved" }),
		"auth.cliDeviceDeny": () => Effect.succeed({ status: "denied" }),
		"auth.mcpOAuthAuthorizationInspect": mcpInspect,
		"emailPublic.unsubscribe": ({ query }) =>
			Effect.succeed({ kind: field(query, "token").startsWith("web-analytics.") ? "web-analytics" : "digest" }),
	}),
	datasets: [
		clerkDataset("clerk", orbitAdmin, {
			"billing.getCustomer": newCustomer(orbitAdmin),
			"billingPublic.listPlans": () => Effect.succeed(plans(true)),
		}),
		clerkDataset("clerk-lapsed", orbitAdmin, {
			// A returning subscriber is not trial-eligible.
			"billing.getCustomer": lapsedCustomer(orbitAdmin),
			"billingPublic.listPlans": () => Effect.succeed(plans(false)),
		}),
		// Acme on Clerk with the generic Startup customer: an org already in the app.
		clerkDataset("clerk-acme", acmeAdmin),
		clerkDataset("clerk-no-org", orglessUser),
		clerkDataset("clerk-signed-out", null),
	],
}
