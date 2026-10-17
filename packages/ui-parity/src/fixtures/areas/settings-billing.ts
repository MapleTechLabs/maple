import { DateTime, Effect } from "effect"
import { isMissingProductEvents } from "@maple/backend/services/warehouse/missing-table"
import { CH, formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import * as Integrations from "@maple/query-engine-integrations"
import { parityOrgId, type FixtureWarehouse } from "../../backend/warehouse.ts"
import type { EndpointHandler, EndpointRequest } from "../dataset.ts"
import { acmeAdmin, DAY } from "../identity.ts"

/**
 * The Clerk-only Billing tab: Autumn and Stripe reads canned (an active Startup subscription ten
 * days into its cycle), the daily spend series through `DailySpendService`'s real queries.
 */

const DAY_MS = 86_400_000
const BYTES_PER_BILLED_GB = 1_000_000_000

const cycleOf = (request: EndpointRequest) => {
	const now = parseWarehouseDateTime(request.dataset.now)
	return { startMs: now - 10 * DAY, endMs: now + 20 * DAY }
}

const usagePrice = (amount: number, billingUnits = 1) => ({ amount, billingUnits, interval: "month" })

/** The live catalog shape (`apps/api/autumn.config.ts`): Startup plus the BYO-cloud add-on. */
const listPlans: EndpointHandler = () =>
	Effect.succeed({
		plans: [
			{
				id: "startup",
				name: "Startup",
				description: null,
				price: { amount: 39, interval: "month" },
				items: [
					{ featureId: "logs", included: 100, price: usagePrice(0.3), feature: { name: "Logs" } },
					{
						featureId: "metrics",
						included: 100,
						price: usagePrice(0.3),
						feature: { name: "Metrics" },
					},
					{
						featureId: "traces",
						included: 100,
						price: usagePrice(0.3),
						feature: { name: "Traces" },
					},
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
				customerEligibility: { status: "active", attachAction: null, trialAvailable: false },
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

/** Cycle-to-date totals as Autumn aggregates them: GB for the byte signals, counts otherwise. */
const usage: EndpointHandler = () =>
	Effect.succeed({
		total: {
			logs: { sum: 41.7 },
			traces: { sum: 63.2 },
			metrics: { sum: 12.4 },
			browser_sessions: { sum: 1842 },
			product_events: { sum: 212_400 },
			ai_credits: { sum: 3.6 },
		},
	})

const invoices: EndpointHandler = (request) =>
	Effect.succeed({
		invoices: [1, 2, 3].map((month) => ({
			stripeId: `in_parity_${month}`,
			planIds: ["startup"],
			status: "paid",
			total: month === 1 ? 52.8 : month === 2 ? 47.1 : 39,
			currency: "usd",
			createdAt: parseWarehouseDateTime(request.dataset.now) - (10 + (month - 1) * 30) * DAY,
			hostedInvoiceUrl: `https://invoice.stripe.test/i/in_parity_${month}`,
		})),
	})

const profile: EndpointHandler = () =>
	Effect.succeed({
		linked: true,
		name: `${acmeAdmin.orgName} Ltd`,
		address: {
			line1: "1 Market Street",
			line2: null,
			city: "London",
			state: null,
			postalCode: "EC1A 1BB",
			country: "GB",
		},
		taxIds: [
			{
				id: "txi_parity_1",
				type: "gb_vat",
				value: "GB123456789",
				country: "GB",
				verificationStatus: "verified",
			},
		],
	})

/** `DailySpendService.get`: three warehouse reads, gap-filled across the whole cycle. */
const dailySpend =
	(warehouse: FixtureWarehouse): EndpointHandler =>
	(request) =>
		Effect.gen(function* () {
			const cycle = cycleOf(request)
			const orgId = parityOrgId(request.dataset.identity?.orgId ?? "org_parity_signed_out")
			const tenant = warehouse.tenantOf(orgId)
			const params = {
				orgId,
				startTime: formatWarehouseDateTime(cycle.startMs),
				endTime: formatWarehouseDateTime(cycle.endMs),
			}
			const run = <A>(compiled: CH.CompiledQueryInput<A>, context: string) =>
				warehouse.executor.compiledQuery(tenant, compiled, { profile: "list", context })
			const signals = yield* run(
				CH.compile(Integrations.dailySignalVolumeQuery(), params),
				"billingDailySignalVolume",
			)
			const sessions = yield* run(
				CH.compile(Integrations.dailySessionCountQuery(), params),
				"billingDailySessionCount",
			)
			// A cluster without `product_events` has ingested none: all zeros, not a failed chart.
			const events = yield* run(
				CH.compile(Integrations.dailyProductEventCountQuery(), params),
				"billingDailyProductEventCount",
			).pipe(Effect.catchIf(isMissingProductEvents, () => Effect.succeed([])))
			const key = (day: DateTime.Utc) =>
				new Date(DateTime.toEpochMillis(day)).toISOString().slice(0, 10)
			const byDay = new Map(signals.map((row) => [key(row.day), row]))
			const sessionsByDay = new Map(sessions.map((row) => [key(row.day), row.sessions]))
			const eventsByDay = new Map(events.map((row) => [key(row.day), row.events]))
			const firstDay = Math.floor(cycle.startMs / DAY_MS) * DAY_MS
			const lastDay = Math.floor(cycle.endMs / DAY_MS) * DAY_MS
			const days = Array.from({ length: (lastDay - firstDay) / DAY_MS + 1 }, (_, index) => {
				const date = new Date(firstDay + index * DAY_MS).toISOString().slice(0, 10)
				const row = byDay.get(date)
				return {
					date,
					logsGB: (row?.logBytes ?? 0) / BYTES_PER_BILLED_GB,
					tracesGB: (row?.traceBytes ?? 0) / BYTES_PER_BILLED_GB,
					metricsGB: (row?.metricBytes ?? 0) / BYTES_PER_BILLED_GB,
					browserSessions: sessionsByDay.get(date) ?? 0,
					productEvents: eventsByDay.get(date) ?? 0,
				}
			})
			return { days, cycleStart: cycle.startMs, cycleEnd: cycle.endMs }
		})

/** Weekly digest on Mondays in the reader's timezone. */
const digest: EndpointHandler = (request) =>
	Effect.succeed({
		id: "0199a0d6-0000-7000-8000-000000000001",
		email: acmeAdmin.email,
		enabled: true,
		dayOfWeek: 1,
		timezone: "Europe/London",
		namespaces: [],
		environments: ["production"],
		lastSentAt: parseWarehouseDateTime(request.dataset.now) - 3 * DAY,
		webAnalyticsEnabled: false,
		createdAt: parseWarehouseDateTime(request.dataset.now) - 40 * DAY,
		updatedAt: parseWarehouseDateTime(request.dataset.now) - 40 * DAY,
	})

/** Tags no default answers; Billing and Notifications only render in Clerk builds. */
export const clerkBillingEndpoints = (
	warehouse: FixtureWarehouse,
): Readonly<Record<string, EndpointHandler>> => ({
	"billingPublic.listPlans": listPlans,
	"billing.getUsage": usage,
	"billing.listInvoices": invoices,
	"billing.getBillingProfile": profile,
	"billing.getDailySpend": dailySpend(warehouse),
	"digest.getSubscription": digest,
})
