import { feature, plan, reward } from "atmn"
import {
	AI_CREDITS_FEATURE_ID,
	AI_CREDITS_MARKUP_PERCENT,
	BILLING_SUB_ORGS_FEATURE_ID,
	ENTERPRISE_SCIM_ADDON_ID,
	ENTERPRISE_SCIM_FEATURE_ID,
	ENTERPRISE_SSO_ADDON_ID,
	ENTERPRISE_SSO_FEATURE_ID,
	OPENROUTER_BYOK_ADDON_ID,
	OPENROUTER_BYOK_FEATURE_ID,
	TRIAL_DURATION_DAYS,
	TRIAL_PLAN_ID,
	TRIAL_SIGNAL_GB,
	UPTIME_MONITOR_OVERAGE_USD,
	UPTIME_MONITORS_FEATURE_ID,
	UPTIME_MONITORS_INCLUDED,
} from "@maple/domain/billing"
import { ONBOARDING_REWARD_ID } from "@maple/domain/onboarding-checklist"

export const logs = feature({
	id: "logs",
	name: "Logs",
	type: "metered",
	consumable: true,
})

export const metrics = feature({
	id: "metrics",
	name: "Metrics",
	type: "metered",
	consumable: true,
})

export const traces = feature({
	id: "traces",
	name: "Traces",
	type: "metered",
	consumable: true,
})

// Continuous CPU profiles, in GB of decoded OTLP profiles. Metered by the ingest gateway
// (`PROFILES_FEATURE_ID` in apps/ingest/src/main.rs).
export const profiles = feature({
	id: "profiles",
	name: "Profiles",
	type: "metered",
	consumable: true,
})

export const browserSessions = feature({
	id: "browser_sessions",
	name: "Browser Sessions",
	type: "metered",
	consumable: true,
})

// Product events (`track()` calls, `/v1/events` rows) — unit is one event.
// Metered by the ingest gateway on both paths (see `PRODUCT_EVENTS_FEATURE_ID`
// in apps/ingest/src/main.rs).
export const productEvents = feature({
	id: "product_events",
	name: "Product Events",
	type: "metered",
	consumable: true,
})

// AI usage in dollars: Autumn prices each model's tokens from models.dev and adds the markup.
// Metered per model by `trackAiCredits` (packages/backend/src/services/billing/autumn-tracker.ts).
// Every model Maple runs on is priced there, so no `modelMarkups` cost overrides are needed.
// Security audits charge it too, in plain dollars: OpenRouter's cost with the same markup, plus a
// sandbox fee per agent (`trackSecurityAuditCharge`).
export const aiCredits = feature({
	id: AI_CREDITS_FEATURE_ID,
	name: "AI Credits",
	type: "ai_credit_system",
	defaultMarkup: AI_CREDITS_MARKUP_PERCENT,
})

// Legacy raw token counts, metered beside `ai_credits` for comparison. Delete once it is trusted.
export const aiInputTokens = feature({
	id: "ai_input_tokens",
	name: "AI Input Tokens",
	type: "metered",
	consumable: true,
})

export const aiOutputTokens = feature({
	id: "ai_output_tokens",
	name: "AI Output Tokens",
	type: "metered",
	consumable: true,
})

// Uptime monitors an org has: continuous use, tracked +1 on create and -1 on delete
// (`UptimeMonitorAllowance` in packages/backend/src/services/uptime).
export const uptimeMonitors = feature({
	id: UPTIME_MONITORS_FEATURE_ID,
	name: "Uptime Monitors",
	type: "metered",
	consumable: false,
})

export const bringYourOwnCloud = feature({
	id: "bringyourowncloud",
	name: "Bring Your Own Cloud",
	type: "boolean",
})

// AI turns run on the org's own OpenRouter key, and its tokens stop being metered here.
export const openRouterByok = feature({
	id: OPENROUTER_BYOK_FEATURE_ID,
	name: "Bring Your Own OpenRouter Key",
	type: "boolean",
})

// The org may pay for sub-orgs. On no public plan: granted per customer in the Autumn dashboard.
export const billingSubOrgs = feature({
	id: BILLING_SUB_ORGS_FEATURE_ID,
	name: "Billing for sub-organizations",
	type: "boolean",
})

// Single sign-on (one SAML/OIDC connection) and SCIM provisioning, granted by their add-ons below.
export const enterpriseSso = feature({
	id: ENTERPRISE_SSO_FEATURE_ID,
	name: "Single sign-on",
	type: "boolean",
})

export const enterpriseScim = feature({
	id: ENTERPRISE_SCIM_FEATURE_ID,
	name: "SCIM provisioning",
	type: "boolean",
})

export const startup = plan({
	id: "startup",
	name: "Startup",
	price: {
		amount: 39,
		interval: "month",
	},
	items: [
		{
			featureId: "logs",
			included: 100,
			price: {
				amount: 0.3,
				billingUnits: 1,
				billingMethod: "usage_based",
				interval: "month",
			},
		},
		{
			featureId: "metrics",
			included: 100,
			price: {
				amount: 0.3,
				billingUnits: 1,
				billingMethod: "usage_based",
				interval: "month",
			},
		},
		{
			featureId: "traces",
			included: 100,
			price: {
				amount: 0.3,
				billingUnits: 1,
				billingMethod: "usage_based",
				interval: "month",
			},
		},
		{
			// Priced above the other byte signals: a profile stores about 28 times its wire size.
			featureId: "profiles",
			included: 10,
			price: {
				amount: 0.6,
				billingUnits: 1,
				billingMethod: "usage_based",
				interval: "month",
			},
		},
		{
			featureId: "browser_sessions",
			included: 5000,
			price: {
				amount: 0.002,
				billingUnits: 1,
				billingMethod: "usage_based",
				interval: "month",
			},
		},
		{
			// $5 per 1M events past 1M. Billed per 1,000 because Autumn rounds
			// overage up to whole blocks; a 1M block would charge $5 for one event.
			featureId: "product_events",
			included: 1_000_000,
			price: {
				amount: 0.005,
				billingUnits: 1000,
				billingMethod: "usage_based",
				interval: "month",
			},
		},
		{
			// Each monitor past the included ones is billed monthly, prorated from the day it is
			// created or deleted. The trial has no price, so there the 11th is refused instead.
			featureId: UPTIME_MONITORS_FEATURE_ID,
			included: UPTIME_MONITORS_INCLUDED,
			proration: { onIncrease: "prorate", onDecrease: "prorate" },
			price: {
				amount: UPTIME_MONITOR_OVERAGE_USD,
				billingUnits: 1,
				billingMethod: "usage_based",
				interval: "month",
			},
		},
		{
			// One credit is one dollar of model spend after markup.
			featureId: "ai_credits",
			included: 1,
			price: {
				amount: 1,
				billingUnits: 1,
				billingMethod: "usage_based",
				interval: "month",
			},
		},
	],
})

// The no-card trial every new org starts on: Startup's allowances with no overage price, so each
// is a hard cap the ingest gateway enforces (`balances.check` denies at zero). Adding a card
// attaches Startup with the days left (`trialForStartupAttach`). The API hides it from the catalog.
export const trial = plan({
	id: TRIAL_PLAN_ID,
	name: "Free trial",
	items: [
		{ featureId: "logs", included: TRIAL_SIGNAL_GB, reset: { interval: "month" } },
		{ featureId: "metrics", included: TRIAL_SIGNAL_GB, reset: { interval: "month" } },
		{ featureId: "traces", included: TRIAL_SIGNAL_GB, reset: { interval: "month" } },
		{ featureId: "profiles", included: 10, reset: { interval: "month" } },
		{ featureId: "browser_sessions", included: 5000, reset: { interval: "month" } },
		{ featureId: "product_events", included: 1_000_000, reset: { interval: "month" } },
		{ featureId: UPTIME_MONITORS_FEATURE_ID, included: UPTIME_MONITORS_INCLUDED },
		// Maple AI waits for a card (`aiCardGateOf`). Zero, not absent: a plan without the
		// balance reads as unmetered, so an empty one is the backstop.
		{ featureId: "ai_credits", included: 0 },
	],
	freeTrial: {
		durationLength: TRIAL_DURATION_DAYS,
		durationType: "day",
		cardRequired: false,
	},
})

export const bringYourOwnCloudAddOn = plan({
	id: "bringyourowncloud",
	name: "Bring Your Own Cloud",
	addOn: true,
	price: {
		amount: 99,
		interval: "month",
	},
	items: [
		{
			featureId: "bringyourowncloud",
		},
	],
})

export const openRouterByokAddOn = plan({
	id: OPENROUTER_BYOK_ADDON_ID,
	name: "Bring Your Own OpenRouter Key",
	addOn: true,
	price: {
		amount: 15,
		interval: "month",
	},
	items: [
		{
			featureId: OPENROUTER_BYOK_FEATURE_ID,
		},
	],
})

// The onboarding checklist's reward: $30 off the next invoice, once, applied by the
// API as a discount on the org's subscription (`billing.update`, see
// `OnboardingChecklistService.claim`). `rewards.redeem` only takes feature grants,
// so a coupon cannot go through it. A `fixed_discount` is the closest thing the
// config builder has to an invoice credit; the API-only `invoice_credits` reward
// type would carry an unused remainder forward, this one does not. No promo code:
// the claim row in Postgres is what makes it once per org, and a public code would
// hand the discount to anyone at checkout.
export const onboardingChecklistReward = reward({
	id: ONBOARDING_REWARD_ID,
	name: "Onboarding checklist credit",
	type: "fixed_discount",
	value: 30,
	duration: { type: "one_off" },
})

// Self-serve on any plan: one SSO connection, and SCIM provisioning on top of it, $100/month each.
export const enterpriseSsoAddOn = plan({
	id: ENTERPRISE_SSO_ADDON_ID,
	name: "Single sign-on",
	addOn: true,
	price: {
		amount: 100,
		interval: "month",
	},
	items: [
		{
			featureId: ENTERPRISE_SSO_FEATURE_ID,
		},
	],
})

export const enterpriseScimAddOn = plan({
	id: ENTERPRISE_SCIM_ADDON_ID,
	name: "SCIM provisioning",
	addOn: true,
	price: {
		amount: 100,
		interval: "month",
	},
	items: [
		{
			featureId: ENTERPRISE_SCIM_FEATURE_ID,
		},
	],
})
