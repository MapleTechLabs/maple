import { feature, plan, reward } from "atmn"
import {
	AI_CREDITS_FEATURE_ID,
	AI_CREDITS_MARKUP_PERCENT,
	BILLING_SUB_ORGS_FEATURE_ID,
	OPENROUTER_BYOK_ADDON_ID,
	OPENROUTER_BYOK_FEATURE_ID,
	UPTIME_MONITORS_FEATURE_ID,
} from "@maple/domain/billing"
import { ONBOARDING_REWARD_ID } from "@maple/domain/onboarding-checklist"

// Features
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
			// A hard allowance: no price, so the 11th monitor is refused rather than billed.
			featureId: UPTIME_MONITORS_FEATURE_ID,
			included: 10,
		},
		{
			// One credit is one dollar of model spend after markup.
			featureId: "ai_credits",
			included: 10,
			price: {
				amount: 1,
				billingUnits: 1,
				billingMethod: "usage_based",
				interval: "month",
			},
		},
	],
	freeTrial: {
		durationLength: 14,
		durationType: "day",
		cardRequired: true,
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
