import { randomBytes } from "node:crypto"
import { fmtMetricTs } from "@maple/backend/services/warehouse/metric-rows"
import { Array as Arr } from "effect"

// Demo browser sessions and product events: `session_replays` rows (what web analytics and the
// funnel population filters read) and the `product_events` page views and track() calls inside
// them, walking a signup funnel so Product analytics has events, funnels and paths to show. Where
// a visitor came from tilts how far they get, and the funnel's events carry properties, so a
// breakdown by channel or by property has something to say.
// Rows use the datasources' ingestion JSON (snake_case, see packages/domain/src/tinybird/datasources.ts).

const HOST = "app.demo-shop.dev"

/** Where a session came from, and how much more (or less) likely its visitor is to take each step. */
const REFERRERS = [
	{ referrerHost: "google.com", utmSource: "", utmMedium: "", utmCampaign: "", lift: 1 },
	{ referrerHost: "github.com", utmSource: "", utmMedium: "", utmCampaign: "", lift: 1.2 },
	{ referrerHost: "news.ycombinator.com", utmSource: "", utmMedium: "", utmCampaign: "", lift: 0.8 },
	{
		referrerHost: "t.co",
		utmSource: "twitter",
		utmMedium: "social",
		utmCampaign: "launch-week",
		lift: 0.6,
	},
	{ referrerHost: "", utmSource: "newsletter", utmMedium: "email", utmCampaign: "november", lift: 1.5 },
	{ referrerHost: "", utmSource: "", utmMedium: "", utmCampaign: "", lift: 1 },
] as const

const CLIENTS = [
	{ browser: "Chrome", os: "Mac OS", device: "desktop" },
	{ browser: "Chrome", os: "Windows", device: "desktop" },
	{ browser: "Safari", os: "iOS", device: "mobile" },
	{ browser: "Firefox", os: "Linux", device: "desktop" },
] as const

const COUNTRIES = ["US", "US", "DE", "GB", "FR", "IN"] as const

/**
 * Each step reached with this chance once the previous one was. Leavers drift to the side events.
 * `property` is the one the event carries, with the values it takes.
 */
const FUNNEL: ReadonlyArray<{
	event: string
	page: string
	chance: number
	property?: readonly [key: string, values: readonly [string, ...ReadonlyArray<string>]]
}> = [
	{ event: "signup_started", page: "/signup", chance: 0.35 },
	{
		event: "signup_completed",
		page: "/onboarding",
		chance: 0.65,
		property: ["method", ["google", "google", "github", "email"]],
	},
	{
		event: "onboarding_connected",
		page: "/onboarding",
		chance: 0.55,
		property: ["source", ["sdk", "sdk", "collector", "cloudflare"]],
	},
	{ event: "dashboard_created", page: "/dashboards", chance: 0.6 },
	{
		event: "plan_started",
		page: "/billing",
		chance: 0.2,
		property: ["plan", ["startup", "startup", "scale"]],
	},
]

const SIDE_EVENTS = [
	{ event: "docs_opened", page: "/docs" },
	{ event: "pricing_viewed", page: "/pricing" },
	{ event: "query_run", page: "/explore" },
] as const

type Rand = () => number

const pick = <A extends readonly [unknown, ...ReadonlyArray<unknown>]>(rand: Rand, items: A): A[number] =>
	items[Math.floor(rand() * items.length)] ?? items[0]
const id = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`

export interface DemoProductRows {
	readonly sessionRows: ReadonlyArray<Record<string, unknown>>
	readonly eventRows: ReadonlyArray<Record<string, unknown>>
}

export const generateDemoProductRows = (input: {
	readonly orgId: string
	readonly hours: number
	readonly visitorsPerHour: number
	readonly nowMs?: number
	/** Draws from the caller's Effect `Random`. */
	readonly random: Rand
}): DemoProductRows => {
	const rand = input.random
	const nowMs = input.nowMs ?? Date.now()
	const windowMs = input.hours * 3600_000
	const visitors = Math.max(1, Math.round(input.hours * input.visitorsPerHour))
	const sessionRows: Array<Record<string, unknown>> = []
	const eventRows: Array<Record<string, unknown>> = []

	Arr.forEach(Arr.range(1, visitors), () => {
		const visitorId = id("v")
		const sessionId = id("s")
		const referral = pick(rand, REFERRERS)
		const client = pick(rand, CLIENTS)
		const country = pick(rand, COUNTRIES)
		const startMs = nowMs - rand() * windowMs * 0.95
		let atMs = startMs
		let seq = 0
		let userId = ""
		const pages: Array<string> = []

		const push = (
			kind: "navigation" | "custom",
			eventName: string,
			pagePath: string,
			attributes: Readonly<Record<string, string>> = {},
		) => {
			atMs += 5_000 + rand() * 90_000
			seq += 1
			if (kind === "navigation") pages.push(pagePath)
			eventRows.push({
				org_id: input.orgId,
				timestamp: fmtMetricTs(Math.min(atMs, nowMs)),
				source: "browser",
				session_id: sessionId,
				seq,
				visitor_id: visitorId,
				user_id: userId,
				kind,
				event_name: eventName,
				host: HOST,
				page_path: pagePath,
				url: `https://${HOST}${pagePath}`,
				service_name: "demo-frontend",
				attributes,
			})
		}
		const visit = (pagePath: string) => push("navigation", "$pageview", pagePath)

		visit("/")
		if (rand() < 0.5) visit("/pricing")
		Arr.every(FUNNEL, (step) => {
			if (rand() >= Math.min(0.95, step.chance * referral.lift)) {
				if (rand() < 0.6) {
					const side = pick(rand, SIDE_EVENTS)
					visit(side.page)
					push("custom", side.event, side.page)
				}
				return false
			}
			visit(step.page)
			if (step.event === "signup_completed") userId = id("u")
			push(
				"custom",
				step.event,
				step.page,
				step.property === undefined ? {} : { [step.property[0]]: pick(rand, step.property[1]) },
			)
			return true
		})

		const endMs = Math.min(atMs + 10_000, nowMs)
		sessionRows.push({
			org_id: input.orgId,
			session_id: sessionId,
			start_time: fmtMetricTs(startMs),
			end_time: fmtMetricTs(endMs),
			duration_ms: Math.round(endMs - startMs),
			status: "ended",
			user_id: userId,
			url_initial: `https://${HOST}/`,
			user_agent: "",
			browser_name: client.browser,
			os_name: client.os,
			device_type: client.device,
			country,
			service_name: "demo-frontend",
			page_views: pages.length,
			click_count: pages.length * 3,
			error_count: 0,
			trace_ids: [],
			resource_attributes: {},
			version: 1,
			visitor_id: visitorId,
			visitor_is_new: 1,
			referrer: referral.referrerHost === "" ? "" : `https://${referral.referrerHost}/`,
			referrer_host: referral.referrerHost,
			utm_source: referral.utmSource,
			utm_medium: referral.utmMedium,
			utm_campaign: referral.utmCampaign,
			host: HOST,
			entry_path: pages[0] ?? "/",
			exit_path: pages.at(-1) ?? "/",
			language: "en-US",
			last_activity_at: fmtMetricTs(endMs),
		})
	})

	return { sessionRows, eventRows }
}
