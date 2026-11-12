import * as Policy from "@maple/domain/policy"
import {
	AiCreditUsageResponse,
	BillingAccount,
	BillingAccountUsageResponse,
	BillingCustomer,
	BillingInvoice,
	BillingProfile,
	BillingUsage,
	CatalogPlan,
	DailySpendResponse,
} from "@maple/domain/http"
import { OrgId } from "@maple/domain"
import { Effect, Option, Schema, Array as Arr } from "effect"
import { AsyncData, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message, Model } from "../page/settings/billing/model"
import { init as billingInit, update as billingUpdate } from "../page/settings/billing/update"
import { view as billingView } from "../page/settings/billing/view"
import type { Resources } from "../platform/resources"

// `/lab/billing-orgs`: the Billing tab per billing role over fixtures. `?state=` picks one:
// member, member-viewer, billing-org, standalone, rejected, and the AI credits section's
// ai-credits (code review spend), ai-credits-chat (no reviews) and ai-credits-loading.

export { Message, Model }

export const LabState = Schema.Literals([
	"member",
	"member-viewer",
	"billing-org",
	"standalone",
	"rejected",
	"ai-credits",
	"ai-credits-chat",
	"ai-credits-loading",
])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState, timeZone: Schema.String })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "member",
	),
	timeZone: "UTC",
}))

const DAY = 86_400_000
const CYCLE_START = Date.UTC(2026, 9, 1)
const NOW_MS = Date.UTC(2026, 9, 28, 12)

const plans = Schema.decodeSync(Schema.Array(CatalogPlan))([
	{
		id: "startup",
		name: "Startup",
		price: { amount: 39, interval: "month" },
		items: [
			{ featureId: "logs", included: 100, price: { amount: 0.3 } },
			{ featureId: "traces", included: 100, price: { amount: 0.3 } },
			{ featureId: "metrics", included: 100, price: { amount: 0.3 } },
			{ featureId: "browser_sessions", included: 5_000, price: { amount: 0.002 } },
			{
				featureId: "product_events",
				included: 1_000_000,
				price: { amount: 0.005, billingUnits: 1_000 },
			},
			{ featureId: "ai_credits", included: 10, price: { amount: 1 } },
		],
	},
])

const customer = Schema.decodeSync(BillingCustomer)({
	id: "org_acme",
	subscriptions: [
		{
			planId: "startup",
			status: "active",
			addOn: false,
			currentPeriodStart: CYCLE_START,
			currentPeriodEnd: CYCLE_START + 31 * DAY,
		},
	],
	balances: {
		logs: { granted: 100 },
		traces: { granted: 100 },
		metrics: { granted: 100 },
		browser_sessions: { granted: 5_000 },
		product_events: { granted: 1_000_000 },
		ai_credits: { granted: 10 },
	},
})

/** Usage per lab state: the AI credits spent match the state's AI credits section. */
const usage = (state: LabState) =>
	Schema.decodeSync(BillingUsage)({
		total: {
			logs: { sum: 142.6 },
			traces: { sum: 61.2 },
			metrics: { sum: 18.4 },
			browser_sessions: { sum: 3_120 },
			product_events: { sum: 0 },
			ai_credits: { sum: state === "ai-credits" ? 16.11 : state === "ai-credits-chat" ? 4.55 : 0 },
		},
	})

const daily = Schema.decodeSync(DailySpendResponse)({
	days: [],
	cycleStart: CYCLE_START,
	cycleEnd: CYCLE_START + 31 * DAY,
})
const invoices = Schema.decodeSync(Schema.Array(BillingInvoice))([
	{
		stripeId: "in_1",
		status: "paid",
		total: 52.4,
		currency: "usd",
		createdAt: Date.UTC(2026, 9, 1),
		planIds: ["startup"],
	},
])
const profile = Schema.decodeSync(BillingProfile)({
	linked: true,
	name: "Acme Inc.",
	address: { line1: "1 Market Street", city: "San Francisco", postalCode: "94105", country: "US" },
	taxIds: [],
})

const acme = { orgId: "org_acme", name: "Acme", imageUrl: null }
const account = (state: LabState) =>
	Schema.decodeUnknownSync(BillingAccount)(
		state === "member" || state === "member-viewer"
			? { orgId: "org_side", role: "member", billingOrg: acme, members: [] }
			: state === "billing-org"
				? {
						orgId: acme.orgId,
						role: "billing_org",
						billingOrg: acme,
						members: [
							{
								orgId: "org_staging",
								name: "Acme Staging",
								imageUrl: null,
								linkedAt: Date.UTC(2026, 7, 14),
							},
							{
								orgId: "org_eu",
								name: "Acme EU",
								imageUrl: null,
								linkedAt: Date.UTC(2026, 9, 3),
							},
						],
					}
				: {
						orgId: "org_side",
						role: "standalone",
						billingOrg: { ...acme, orgId: "org_side" },
						members: [],
					},
	)

const accountUsage = Schema.decodeSync(BillingAccountUsageResponse)({
	cycleStartMs: CYCLE_START,
	cycleEndMs: CYCLE_START + 31 * DAY,
	orgs: [
		{
			orgId: "org_acme",
			logsGB: 120,
			tracesGB: 50,
			metricsGB: 15,
			browserSessions: 3_120,
			productEvents: 0,
		},
		{
			orgId: "org_staging",
			logsGB: 4.2,
			tracesGB: 1.1,
			metricsGB: 0.3,
			browserSessions: 0,
			productEvents: 0,
		},
		{
			orgId: "org_eu",
			logsGB: 18.4,
			tracesGB: 10.1,
			metricsGB: 3.1,
			browserSessions: 0,
			productEvents: 0,
		},
	],
})

const choices = [
	{ orgId: Schema.decodeSync(OrgId)("org_acme"), name: "Acme", imageUrl: "" },
	{ orgId: Schema.decodeSync(OrgId)("org_globex"), name: "Globex", imageUrl: "" },
]

const REPO = "00000000-0000-4000-8000-000000000001"
const API_REPO = "00000000-0000-4000-8000-000000000002"
const pullRequest = (number: number, title: string, reviews: number, credits: number, repo = REPO) => ({
	repositoryId: repo,
	fullName: repo === REPO ? "acme/web" : "acme/api",
	number,
	title,
	url: `https://github.com/acme/${repo === REPO ? "web" : "api"}/pull/${number}`,
	reviews,
	credits,
})

/** This cycle's AI credits per lab state: an org whose spend is code review, one that only chats, none. */
const aiUsage = (state: LabState) =>
	Schema.decodeSync(AiCreditUsageResponse)(
		state === "ai-credits"
			? {
					bySource: [
						{ source: "review", credits: 14.08 },
						{ source: "chat", credits: 1.42 },
						{ source: "triage", credits: 0.61 },
					],
					days: [],
					byModel: [
						{ model: "openrouter/deepseek/deepseek-v4.1-flash-1017", credits: 14.11 },
						{ model: "openrouter/anthropic/claude-sonnet-5.5", credits: 2 },
					],
					codeReview: {
						reviews: 230,
						pullRequests: 160,
						credits: 14.08,
						unpricedReviews: 0,
						reReviews: 70,
						reReviewCredits: 5.2,
						repositories: [
							{
								repositoryId: REPO,
								fullName: "acme/web",
								pullRequests: 141,
								reviews: 204,
								credits: 12.31,
							},
							{
								repositoryId: API_REPO,
								fullName: "acme/api",
								pullRequests: 19,
								reviews: 26,
								credits: 1.77,
							},
						],
						topPullRequests: [
							pullRequest(2288, "Move session sync onto the job queue", 3, 0.92),
							pullRequest(2210, "Retry webhook delivery with backoff", 7, 0.78),
							pullRequest(2224, "Paginate the contacts export", 7, 0.67),
							pullRequest(311, "Rate limit the public API per key", 1, 0.5, API_REPO),
							pullRequest(2146, "Cache the inbox counts", 6, 0.49),
							pullRequest(2223, "Split the billing worker", 4, 0.47),
							pullRequest(2111, "Store attachments in R2", 3, 0.41),
							pullRequest(2289, "Fix the flaky threads test", 5, 0.38),
						],
					},
				}
			: state === "ai-credits-chat"
				? {
						bySource: [
							{ source: "chat", credits: 3.4 },
							{ source: "triage", credits: 1.15 },
						],
						days: [],
						byModel: [{ model: "openrouter/anthropic/claude-sonnet-5.5", credits: 4.55 }],
						codeReview: null,
					}
				: { bySource: [], days: [], byModel: [], codeReview: null },
	)

type Return = Update.Return<Model, Message, Resources>

export const init = (flags: Flags): Return => {
	const base = billingInit(flags.state === "member-viewer" ? [] : Policy.allPermissions, false, true).model
	const role = account(flags.state).role
	return {
		model: {
			...base,
			plans: AsyncData.Success({ data: plans }),
			usage: AsyncData.Success({ data: usage(flags.state) }),
			daily: AsyncData.Success({ data: daily }),
			aiUsage:
				flags.state === "ai-credits-loading"
					? AsyncData.Loading()
					: AsyncData.Success({ data: aiUsage(flags.state) }),
			account: AsyncData.Success({ data: account(flags.state) }),
			...(role !== "member" && {
				invoices: AsyncData.Success({ data: invoices }),
				profile: AsyncData.Success({ data: profile }),
			}),
			...(role === "billing_org" && { accountUsage: AsyncData.Success({ data: accountUsage }) }),
			...(role === "standalone" && { orgChoices: AsyncData.Success({ data: choices }) }),
			...(flags.state === "rejected" && {
				linkOrgId: choices[1]?.orgId ?? null,
				linkRejection:
					"Billing through another organization isn't enabled for Globex yet. Ask Maple support to turn it on.",
			}),
		},
	}
}

/** Dialogs and pickers work; reads and writes are dropped, the fixture is all the data there is. */
export const update = (model: Model, message: Message): Return => {
	const step = billingUpdate(model, message, customer, NOW_MS).step
	return {
		model: step.model,
		commands: Arr.filter(
			step.commands ?? [],
			(command) => !/^(Fetch|Link|Unlink|Update|Open|Attach)/.test(command.name),
		),
	}
}

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("mx-auto w-full max-w-4xl p-6")],
		[
			h.submodel({
				slotId: "lab-billing",
				model,
				view: billingView,
				toParentMessage: (message: Message) => message,
				viewInputs: {
					customer: AsyncData.Success({ data: customer }),
					adminName: null,
					isKnownMember: false,
					nowMs: NOW_MS,
					timeZone: "UTC",
				},
			}),
		],
	)
