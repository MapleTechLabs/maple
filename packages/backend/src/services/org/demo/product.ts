import { randomBytes } from "node:crypto"
import { fmtMetricTs } from "@maple/backend/services/warehouse/metric-rows"

// Demo browser sessions and product events: `session_replays` rows (what web analytics and the
// funnel population filters read) and the `product_events` page views and track() calls inside
// them, walking a signup funnel so Product analytics has events, funnels and paths to show.
// Rows use the datasources' ingestion JSON (snake_case, see packages/domain/src/tinybird/datasources.ts).

const HOST = "app.demo-shop.dev"

const REFERRERS = [
	{ referrerHost: "google.com", utmSource: "" },
	{ referrerHost: "github.com", utmSource: "" },
	{ referrerHost: "news.ycombinator.com", utmSource: "" },
	{ referrerHost: "", utmSource: "newsletter" },
	{ referrerHost: "", utmSource: "" },
] as const

const CLIENTS = [
	{ browser: "Chrome", os: "Mac OS", device: "desktop" },
	{ browser: "Chrome", os: "Windows", device: "desktop" },
	{ browser: "Safari", os: "iOS", device: "mobile" },
	{ browser: "Firefox", os: "Linux", device: "desktop" },
] as const

const COUNTRIES = ["US", "US", "DE", "GB", "FR", "IN"] as const

/** Each step reached with this chance once the previous one was. Leavers drift to the side events. */
const FUNNEL: ReadonlyArray<{ event: string; page: string; chance: number }> = [
	{ event: "signup_started", page: "/signup", chance: 0.35 },
	{ event: "signup_completed", page: "/onboarding", chance: 0.65 },
	{ event: "onboarding_connected", page: "/onboarding", chance: 0.55 },
	{ event: "dashboard_created", page: "/dashboards", chance: 0.6 },
	{ event: "plan_started", page: "/billing", chance: 0.2 },
]

const SIDE_EVENTS = [
	{ event: "docs_opened", page: "/docs" },
	{ event: "pricing_viewed", page: "/pricing" },
	{ event: "query_run", page: "/explore" },
] as const

const pick = <A extends readonly [unknown, ...ReadonlyArray<unknown>]>(items: A): A[number] =>
	items[Math.floor(Math.random() * items.length)] ?? items[0]
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
}): DemoProductRows => {
	const nowMs = input.nowMs ?? Date.now()
	const windowMs = input.hours * 3600_000
	const visitors = Math.max(1, Math.round(input.hours * input.visitorsPerHour))
	const sessionRows: Array<Record<string, unknown>> = []
	const eventRows: Array<Record<string, unknown>> = []

	Array.from({ length: visitors }).forEach(() => {
		const visitorId = id("v")
		const sessionId = id("s")
		const referral = pick(REFERRERS)
		const client = pick(CLIENTS)
		const country = pick(COUNTRIES)
		const startMs = nowMs - Math.random() * windowMs * 0.95
		let atMs = startMs
		let seq = 0
		let userId = ""
		const pages: Array<string> = []

		const push = (kind: "navigation" | "custom", eventName: string, pagePath: string) => {
			atMs += 5_000 + Math.random() * 90_000
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
			})
		}
		const visit = (pagePath: string) => push("navigation", "$pageview", pagePath)

		visit("/")
		if (Math.random() < 0.5) visit("/pricing")
		FUNNEL.every((step) => {
			if (Math.random() >= step.chance) {
				if (Math.random() < 0.6) {
					const side = pick(SIDE_EVENTS)
					visit(side.page)
					push("custom", side.event, side.page)
				}
				return false
			}
			visit(step.page)
			if (step.event === "signup_completed") userId = id("u")
			push("custom", step.event, step.page)
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
			host: HOST,
			entry_path: pages[0] ?? "/",
			exit_path: pages.at(-1) ?? "/",
			language: "en-US",
			last_activity_at: fmtMetricTs(endMs),
		})
	})

	return { sessionRows, eventRows }
}
