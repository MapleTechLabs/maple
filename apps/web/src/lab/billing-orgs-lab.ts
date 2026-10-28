import {
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
import { Effect, Option, Schema } from "effect"
import { AsyncData, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message, Model } from "../page/settings/billing/model"
import { init as billingInit, update as billingUpdate } from "../page/settings/billing/update"
import { view as billingView } from "../page/settings/billing/view"
import type { Resources } from "../platform/resources"

// `/lab/billing-orgs`: the Billing tab per billing role over fixtures. `?state=` picks one:
// member, member-viewer, billing-org, standalone, rejected.

export { Message, Model }

export const LabState = Schema.Literals(["member", "member-viewer", "billing-org", "standalone", "rejected"])
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

const plans = Schema.decodeUnknownSync(Schema.Array(CatalogPlan))([
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
		],
	},
])

const customer = Schema.decodeUnknownSync(BillingCustomer)({
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
	},
})

const usage = Schema.decodeUnknownSync(BillingUsage)({
	total: {
		logs: { sum: 142.6 },
		traces: { sum: 61.2 },
		metrics: { sum: 18.4 },
		browser_sessions: { sum: 3_120 },
		product_events: { sum: 0 },
	},
})

const daily = Schema.decodeUnknownSync(DailySpendResponse)({
	days: [],
	cycleStart: CYCLE_START,
	cycleEnd: CYCLE_START + 31 * DAY,
})
const invoices = Schema.decodeUnknownSync(Schema.Array(BillingInvoice))([
	{
		stripeId: "in_1",
		status: "paid",
		total: 52.4,
		currency: "usd",
		createdAt: Date.UTC(2026, 9, 1),
		planIds: ["startup"],
	},
])
const profile = Schema.decodeUnknownSync(BillingProfile)({
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

const accountUsage = Schema.decodeUnknownSync(BillingAccountUsageResponse)({
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

type Return = Update.Return<Model, Message, Resources>

export const init = (flags: Flags): Return => {
	const base = billingInit(flags.state !== "member-viewer", false, true).model
	const role = account(flags.state).role
	return {
		model: {
			...base,
			plans: AsyncData.Success({ data: plans }),
			usage: AsyncData.Success({ data: usage }),
			daily: AsyncData.Success({ data: daily }),
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
		commands: (step.commands ?? []).filter(
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
