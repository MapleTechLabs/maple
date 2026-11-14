// Example products for the funnel scenario suite. Each is a seeded simulation of how people move
// through a product, shaped to hit a different part of the funnel query: identity stitching,
// server-side steps, repeated events, restarts, attribute filters, page steps and session steps.

import { Array as Arr } from "effect"
import {
	DAY_MS,
	type Dataset,
	event,
	HOUR_MS,
	MINUTE_MS,
	type Rng,
	seeded,
	session,
	type SimEvent,
	type SimSession,
} from "./funnel-scenarios-support"

const REFERRALS = [
	{ referrerHost: "google.com", utmSource: "", utmMedium: "", utmCampaign: "" },
	{ referrerHost: "news.ycombinator.com", utmSource: "", utmMedium: "", utmCampaign: "" },
	{ referrerHost: "t.co", utmSource: "twitter", utmMedium: "social", utmCampaign: "launch-week" },
	{ referrerHost: "", utmSource: "newsletter", utmMedium: "email", utmCampaign: "november" },
	{ referrerHost: "", utmSource: "", utmMedium: "", utmCampaign: "" },
] as const

const COUNTRIES = ["US", "US", "US", "DE", "DE", "GB", "FR", "IN"] as const
const DEVICES = [
	{ deviceType: "desktop", browserName: "Chrome" },
	{ deviceType: "desktop", browserName: "Firefox" },
	{ deviceType: "mobile", browserName: "Safari" },
] as const

/** Collects one dataset's rows and hands out a per-session sequence. */
const recorder = (orgId: string) => {
	const events: Array<SimEvent> = []
	const sessions: Array<SimSession> = []
	const seqBySession = new Map<string, number>()
	const nextSeq = (sessionId: string): number => {
		const seq = seqBySession.get(sessionId) ?? 0
		seqBySession.set(sessionId, seq + 1)
		return seq
	}
	return {
		track: (fields: Parameters<typeof event>[0]) => {
			events.push(
				event({ ...fields, seq: fields.sessionId === undefined ? 0 : nextSeq(fields.sessionId) }),
			)
		},
		open: (fields: Parameters<typeof session>[0]) => {
			sessions.push(session(fields))
		},
		done: (): Dataset => ({ orgId, events, sessions }),
	}
}

const spread = (rng: Rng, days: number): number => rng.int(days * DAY_MS)
const pause = (rng: Rng, minMs: number, maxMs: number): number => minMs + rng.int(maxMs - minMs)

/**
 * A B2B SaaS signup: anonymous marketing visits on `acme.dev`, a signup that the backend confirms
 * with a user id only, onboarding in the app under the same visitor, and a plan that starts days
 * later from a billing webhook. Some people visit twice before signing up, and some use two browsers.
 */
export const saasSignup = (orgId = "scenario_saas"): Dataset => {
	const rng = seeded(11)
	const data = recorder(orgId)
	Arr.forEach(Arr.range(1, 320), (n) => {
		const visitorId = `v${n}`
		const referral = rng.pick(REFERRALS)
		const device = rng.pick(DEVICES)
		const country = rng.pick(COUNTRIES)
		const marketing = (sessionId: string, startMs: number, entry: typeof referral): number => {
			data.open({ sessionId, startMs, visitorId, host: "acme.dev", country, ...device, ...entry })
			const browser = { sessionId, visitorId, host: "acme.dev" } as const
			let atMs = startMs
			data.track({ ...browser, atMs, kind: "navigation", eventName: "$pageview", pagePath: "/" })
			if (rng.chance(0.6)) {
				atMs += pause(rng, 5_000, 2 * MINUTE_MS)
				data.track({
					...browser,
					atMs,
					kind: "navigation",
					eventName: "$pageview",
					pagePath: "/pricing",
				})
			}
			if (rng.chance(0.25)) {
				atMs += pause(rng, 5_000, MINUTE_MS)
				data.track({
					...browser,
					atMs,
					kind: "navigation",
					eventName: "$pageview",
					pagePath: "/docs",
				})
			}
			return atMs
		}

		let startMs = spread(rng, 10)
		let atMs = marketing(`s${n}a`, startMs, referral)
		// A quarter leave and come back days later, direct, before they decide.
		if (rng.chance(0.25)) {
			startMs += pause(rng, DAY_MS, 4 * DAY_MS)
			atMs = marketing(`s${n}b`, startMs, REFERRALS[4])
		}
		if (!rng.chance(0.42)) return
		const sessionId = `s${n}-signup`
		atMs += pause(rng, 10_000, 3 * MINUTE_MS)
		data.open({ sessionId, startMs: atMs, visitorId, host: "acme.dev", country, ...device })
		data.track({
			sessionId,
			visitorId,
			host: "acme.dev",
			atMs,
			eventName: "signup_started",
			pagePath: "/signup",
		})
		if (!rng.chance(0.7)) return

		const userId = `u${n}`
		const plan = rng.pick(["free", "free", "startup", "scale"] as const)
		atMs += pause(rng, 20_000, 4 * MINUTE_MS)
		// The backend knows the user, not the browser: no visitor and no session on these rows.
		data.track({ atMs, micro: rng.int(1000), source: "server", userId, eventName: "signup_completed" })

		const appSession = `s${n}-app`
		atMs += pause(rng, 2_000, 30_000)
		data.open({
			sessionId: appSession,
			startMs: atMs,
			visitorId,
			userId,
			host: "app.acme.dev",
			country,
			...device,
		})
		const app = { sessionId: appSession, visitorId, userId, host: "app.acme.dev" } as const
		data.track({ ...app, atMs, kind: "navigation", eventName: "$pageview", pagePath: "/onboarding" })
		if (rng.chance(0.75)) {
			atMs += pause(rng, 30_000, 20 * MINUTE_MS)
			data.track({
				...app,
				atMs,
				eventName: "onboarding_step_completed",
				attributes: { step: "connect" },
			})
			if (rng.chance(0.8)) {
				atMs += pause(rng, MINUTE_MS, 3 * HOUR_MS)
				data.track({
					atMs,
					micro: rng.int(1000),
					source: "server",
					userId,
					eventName: "first_trace_received",
				})
			}
		}
		// One in eight continues on a second browser: another visitor that links to the same user.
		if (rng.chance(0.125)) {
			const other = `v${n}-laptop`
			const laptop = `s${n}-laptop`
			atMs += pause(rng, HOUR_MS, DAY_MS)
			data.open({
				sessionId: laptop,
				startMs: atMs,
				visitorId: other,
				userId,
				host: "app.acme.dev",
				country,
			})
			data.track({
				sessionId: laptop,
				visitorId: other,
				userId,
				host: "app.acme.dev",
				atMs,
				eventName: "dashboard_created",
			})
		}
		if (plan !== "free" && rng.chance(0.6)) {
			atMs += pause(rng, 2 * HOUR_MS, 9 * DAY_MS)
			data.track({
				atMs,
				micro: rng.int(1000),
				source: "server",
				userId,
				eventName: "plan_started",
				attributes: { plan },
			})
		}
	})
	return data.done()
}

/**
 * A shop checkout: people view several products, add to cart, start checkout and pay; the order is
 * confirmed server-side. Many abandon and start over the next day, so one person runs the funnel
 * more than once, and guests check out under a visitor id only.
 */
export const shopCheckout = (orgId = "scenario_shop"): Dataset => {
	const rng = seeded(23)
	const data = recorder(orgId)
	const categories = ["shoes", "jackets", "bags"] as const
	const methods = ["card", "card", "paypal", "klarna"] as const
	Arr.forEach(Arr.range(1, 260), (n) => {
		const visitorId = `shopper${n}`
		const userId = rng.chance(0.4) ? `account${n}` : ""
		const device = rng.pick(DEVICES)
		const country = rng.pick(COUNTRIES)
		const referral = rng.pick(REFERRALS)
		const attempts = rng.chance(0.3) ? 2 : 1
		let startMs = spread(rng, 12)
		Arr.forEach(Arr.range(1, attempts), (attempt) => {
			const sessionId = `shop${n}-${attempt}`
			data.open({
				sessionId,
				startMs,
				visitorId,
				userId,
				host: "shop.example",
				country,
				...device,
				...referral,
			})
			const browser = { sessionId, visitorId, userId, host: "shop.example" } as const
			let atMs = startMs
			const views = 1 + rng.int(5)
			const category = rng.pick(categories)
			Arr.forEach(Arr.range(1, views), () => {
				atMs += pause(rng, 3_000, 90_000)
				data.track({ ...browser, atMs, eventName: "product_viewed", attributes: { category } })
			})
			startMs += pause(rng, 20 * HOUR_MS, 3 * DAY_MS)
			if (!rng.chance(0.55)) return
			atMs += pause(rng, 3_000, 60_000)
			data.track({ ...browser, atMs, eventName: "add_to_cart", attributes: { category } })
			if (!rng.chance(0.6)) return
			atMs += pause(rng, 5_000, 5 * MINUTE_MS)
			data.track({
				...browser,
				atMs,
				kind: "navigation",
				eventName: "$pageview",
				pagePath: "/checkout",
			})
			data.track({ ...browser, atMs, eventName: "checkout_started" })
			if (!rng.chance(0.65)) return
			const method = rng.pick(methods)
			atMs += pause(rng, 20_000, 6 * MINUTE_MS)
			data.track({ ...browser, atMs, eventName: "payment_submitted", attributes: { method } })
			if (!rng.chance(0.9)) return
			// Guests have no account: the order row carries the visitor id the checkout sent along.
			atMs += pause(rng, 300, 4_000)
			data.track({
				atMs,
				micro: rng.int(1000),
				source: "server",
				visitorId: userId === "" ? visitorId : "",
				userId,
				eventName: "order_completed",
				attributes: { method, coupon: rng.chance(0.2) ? "WELCOME10" : "" },
			})
		})
	})
	return data.done()
}

/**
 * A mobile app's onboarding, sent straight to the events endpoint: screens and taps under an
 * install id, with the user id appearing once an account exists. No browser sessions at all.
 */
export const mobileOnboarding = (orgId = "scenario_mobile"): Dataset => {
	const rng = seeded(37)
	const data = recorder(orgId)
	Arr.forEach(Arr.range(1, 240), (n) => {
		const visitorId = `install-${n}`
		const base = { source: "mobile", visitorId } as const
		let atMs = spread(rng, 14)
		const screen = (name: string, userId = "") => {
			atMs += pause(rng, 1_500, 40_000)
			data.track({ ...base, userId, atMs, kind: "screen", eventName: "$screen", pagePath: name })
		}
		data.track({
			...base,
			atMs,
			eventName: "app_opened",
			attributes: { platform: rng.pick(["ios", "android"]) },
		})
		screen("Welcome")
		if (!rng.chance(0.8)) return
		screen("Permissions")
		atMs += pause(rng, 1_000, 20_000)
		data.track({
			...base,
			atMs,
			eventName: "permission_answered",
			attributes: { permission: "notifications", answer: rng.chance(0.6) ? "granted" : "denied" },
		})
		if (!rng.chance(0.7)) return
		const userId = `member${n}`
		atMs += pause(rng, 5_000, 2 * MINUTE_MS)
		data.track({
			...base,
			userId,
			atMs,
			eventName: "account_created",
			attributes: { method: rng.pick(["apple", "email"]) },
		})
		screen("Home", userId)
		if (!rng.chance(0.5)) return
		atMs += pause(rng, MINUTE_MS, 2 * DAY_MS)
		data.track({ ...base, userId, atMs, eventName: "workout_logged" })
		if (rng.chance(0.4)) {
			atMs += pause(rng, DAY_MS, 5 * DAY_MS)
			data.track({ ...base, userId, atMs, eventName: "workout_logged" })
		}
	})
	return data.done()
}

/**
 * A docs site and its app on two hosts that share paths: the same `/pricing` exists on both, so a
 * page step without a host and one with a host must count differently.
 */
export const contentSite = (orgId = "scenario_content"): Dataset => {
	const rng = seeded(41)
	const data = recorder(orgId)
	const hosts = ["docs.acme.dev", "acme.dev"] as const
	Arr.forEach(Arr.range(1, 200), (n) => {
		const visitorId = `reader${n}`
		const host = rng.pick(hosts)
		const sessionId = `read${n}`
		let atMs = spread(rng, 8)
		const referral = rng.pick(REFERRALS)
		data.open({ sessionId, startMs: atMs, visitorId, host, country: rng.pick(COUNTRIES), ...referral })
		const view = (pagePath: string, on: string = host) => {
			atMs += pause(rng, 2_000, 3 * MINUTE_MS)
			data.track({
				sessionId,
				visitorId,
				host: on,
				atMs,
				kind: "navigation",
				eventName: "$pageview",
				pagePath,
			})
		}
		view(host === "docs.acme.dev" ? "/quickstart" : "/")
		if (rng.chance(0.5)) view("/pricing")
		if (rng.chance(0.3)) view("/pricing", "acme.dev")
		if (rng.chance(0.35)) {
			view("/signup", "acme.dev")
			if (rng.chance(0.5)) {
				atMs += pause(rng, 5_000, 2 * MINUTE_MS)
				data.track({ sessionId, visitorId, host: "acme.dev", atMs, eventName: "signup_started" })
			}
		}
	})
	return data.done()
}

export const SCENARIOS = { saasSignup, shopCheckout, mobileOnboarding, contentSite } as const
