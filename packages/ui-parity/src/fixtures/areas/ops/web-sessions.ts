import { makePrng, type NonEmpty } from "../../prng.ts"
import { formatMicros, type WarehouseRow } from "../../telemetry/rows.ts"
import { HOUR, MINUTE } from "../../identity.ts"
import { lookup } from "./synthetic.ts"
import { featuredRecording } from "./web-recording.ts"

/**
 * Acme's storefront as the browser SDK records it: `session_replays` (one row per session,
 * written at end as Version 2), `session_events` (navigation, clicks, network, errors, custom
 * events; the `product_events_mv` view derives page views from them) and, for one featured
 * session, inline rrweb chunks in `session_replay_events`. Own PRNG, own org.
 */

export const ACME_WEB_ORG = "org_parity_acme_web"
/** The checkout session the replay detail scenario opens. */
export const FEATURED_SESSION_ID = "a11ce5e55100c0ffee00000000000001"

const HOST = "shop.acme.test"
const SESSIONS = 180

const PAGES: NonEmpty<readonly [string, number]> = [
	["/", 30],
	["/products", 18],
	["/products/espresso-grinder", 12],
	["/products/pour-over-kettle", 9],
	["/products/burr-set", 5],
	["/cart", 10],
	["/checkout", 6],
	["/account", 4],
	["/blog/dialing-in-espresso", 6],
]
const BROWSERS: NonEmpty<readonly [readonly [string, string, string], number]> = [
	[["Chrome", "macOS", "desktop"], 34],
	[["Chrome", "Windows", "desktop"], 20],
	[["Safari", "iOS", "mobile"], 22],
	[["Chrome", "Android", "mobile"], 12],
	[["Firefox", "Linux", "desktop"], 6],
	[["Safari", "iPadOS", "tablet"], 4],
	[["Edge", "Windows", "desktop"], 4],
]
const COUNTRIES: NonEmpty<readonly [string, number]> = [
	["US", 38],
	["DE", 14],
	["GB", 12],
	["FR", 8],
	["CA", 8],
	["NL", 6],
	["JP", 5],
	["BR", 4],
	["IN", 5],
]
const LANGUAGES = {
	US: "en-US",
	DE: "de-DE",
	GB: "en-GB",
	FR: "fr-FR",
	CA: "en-CA",
	NL: "nl-NL",
	JP: "ja-JP",
	BR: "pt-BR",
	IN: "en-IN",
}
const REFERRERS: NonEmpty<readonly [readonly [string, string, string, string], number]> = [
	[["", "", "", ""], 36],
	[["https://www.google.com/", "www.google.com", "", ""], 26],
	[["https://news.ycombinator.com/", "news.ycombinator.com", "", ""], 6],
	[["https://www.reddit.com/r/espresso/", "www.reddit.com", "", ""], 8],
	[["https://chatgpt.com/", "chatgpt.com", "", ""], 4],
	[["https://newsletter.acme.test/", "newsletter.acme.test", "newsletter", "email"], 10],
	[["https://www.instagram.com/", "www.instagram.com", "instagram", "social"], 6],
]
const EVENTS: NonEmpty<readonly [string, number]> = [
	["add_to_cart", 10],
	["product_viewed", 18],
	["search", 7],
	["checkout_started", 4],
	["newsletter_signup", 2],
]
const UA = {
	Chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
	Safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
	Firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
	Edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0",
}
const SHOPPERS: NonEmpty<readonly [string, string]> = [
	["Maria Garcia", "maria@example.test"],
	["Kenji Watanabe", "kenji@example.test"],
	["Amara Okafor", "amara@example.test"],
	["Lukas Becker", "lukas@example.test"],
]

const ms = (value: number) => value * 1000

/** Sessions per hours-ago bucket: the frozen clock is noon UTC, so the evening peak sits ~8 h back. */
const hourWeight = (hoursAgo: number) => 3 + Math.round(4 * Math.sin(((hoursAgo + 6) / 24) * Math.PI) ** 2)
const HOURS_AGO: NonEmpty<readonly [number, number]> = [
	[0, hourWeight(0)],
	...Array.from({ length: 23 }, (_, index) => [index + 1, hourWeight(index + 1)] as const),
]

interface Visit {
	readonly id: string
	readonly startMs: number
	readonly path: ReadonlyArray<string>
	readonly gapsMs: ReadonlyArray<number>
	readonly browser: readonly [string, string, string]
	readonly country: string
	readonly referrer: readonly [string, string, string, string]
	readonly visitor: string
	readonly visitorIsNew: boolean
	readonly user: readonly [string, string] | undefined
	readonly errors: number
	readonly custom: ReadonlyArray<string>
}

/** Day-shaped traffic: more sessions in the afternoon (UTC), never in the last minute. */
const visits = (nowMs: number): ReadonlyArray<Visit> => {
	const rng = makePrng(4242)
	const generated = Array.from({ length: SESSIONS }, (): Visit => {
		const hoursAgo = rng.weighted(HOURS_AGO)
		// At most 6 pages of 140 s, so every session has ended by `now`.
		const startMs = Math.floor(nowMs - hoursAgo * HOUR - rng.next() * HOUR - 15 * MINUTE)
		const path = Array.from({ length: rng.int(1, 6) }, () => rng.weighted(PAGES))
		const user = rng.chance(0.3) ? rng.pick(SHOPPERS) : undefined
		return {
			id: rng.hex(32),
			startMs,
			path,
			gapsMs: path.map(() => ms(rng.int(8, 140))),
			browser: rng.weighted(BROWSERS),
			country: rng.weighted(COUNTRIES),
			referrer: rng.weighted(REFERRERS),
			visitor: `v_${rng.hex(16)}`,
			visitorIsNew: rng.chance(0.55),
			user,
			errors: rng.chance(0.08) ? rng.int(1, 3) : 0,
			custom: path.flatMap(() => (rng.chance(0.4) ? [rng.weighted(EVENTS)] : [])),
		}
	})
	return [featuredVisit(nowMs), ...generated]
}

const featuredVisit = (nowMs: number): Visit => ({
	id: FEATURED_SESSION_ID,
	startMs: nowMs - 42 * MINUTE,
	path: ["/", "/products/espresso-grinder", "/cart", "/checkout"],
	gapsMs: [ms(35), ms(70), ms(40), ms(95)],
	browser: ["Chrome", "macOS", "desktop"],
	country: "US",
	referrer: ["https://www.google.com/", "www.google.com", "", ""],
	visitor: "v_featured00000001",
	visitorIsNew: false,
	user: SHOPPERS[0],
	errors: 1,
	custom: ["product_viewed", "add_to_cart", "checkout_started"],
})

const micros = (value: number) => formatMicros(value * 1000)
const url = (path: string) => `https://${HOST}${path}`
const userIdOf = (visit: Visit) =>
	visit.user === undefined ? "" : `user_${visit.user[1].split("@")[0] ?? ""}`

/** Each page's offset from the session start, then the end. */
const offsets = (visit: Visit) =>
	visit.gapsMs.reduce<ReadonlyArray<number>>((acc, gap, index) => [...acc, (acc[index] ?? 0) + gap], [0])

const endMsOf = (visit: Visit) => visit.startMs + (offsets(visit).at(-1) ?? 0)

const replayRow = (visit: Visit, recorded: boolean): WarehouseRow => {
	const [browser, os, device] = visit.browser
	const [referrer, referrerHost, utmSource, utmMedium] = visit.referrer
	const endMs = endMsOf(visit)
	return {
		OrgId: ACME_WEB_ORG,
		SessionId: visit.id,
		StartTime: micros(visit.startMs),
		EndTime: micros(endMs),
		DurationMs: endMs - visit.startMs,
		Status: "ended",
		UserId: userIdOf(visit),
		UrlInitial: url(visit.path[0] ?? "/"),
		UserAgent: lookup(UA, browser) ?? "",
		BrowserName: browser,
		OsName: os,
		DeviceType: device,
		Country: visit.country,
		ServiceName: "storefront",
		PageViews: visit.path.length,
		ClickCount: visit.path.length * 2 + visit.custom.length,
		ErrorCount: visit.errors,
		TraceIds: [],
		ResourceAttributes: {
			"maple.session.recorded": recorded ? "true" : "false",
			"service.name": "storefront",
		},
		Version: 2,
		VisitorId: visit.visitor,
		VisitorIsNew: visit.visitorIsNew ? 1 : 0,
		UserEmail: visit.user?.[1] ?? "",
		UserName: visit.user?.[0] ?? "",
		GroupId: "",
		GroupName: "",
		UserTraits: visit.user === undefined ? {} : { plan: "member" },
		Referrer: referrer,
		ReferrerHost: referrerHost,
		UtmSource: utmSource,
		UtmMedium: utmMedium,
		UtmCampaign: utmSource === "" ? "" : "autumn-roast",
		UtmTerm: "",
		UtmContent: "",
		Host: HOST,
		EntryPath: visit.path[0] ?? "/",
		ExitPath: visit.path.at(-1) ?? "/",
		Language: lookup(LANGUAGES, visit.country) ?? "en-US",
		LastActivityAt: micros(endMs),
	}
}

const eventRow = (
	visit: Visit,
	seq: number,
	atMs: number,
	fields: Readonly<Record<string, unknown>>,
): WarehouseRow => ({
	OrgId: ACME_WEB_ORG,
	SessionId: visit.id,
	Timestamp: micros(atMs),
	Seq: seq,
	TraceId: "",
	Level: "",
	Message: "",
	TargetSelector: "",
	TargetText: "",
	NetMethod: "",
	NetUrl: "",
	NetStatus: 0,
	NetDurationMs: 0,
	ErrorStack: "",
	Attributes: {},
	VisitorId: visit.visitor,
	UserId: userIdOf(visit),
	GroupId: "",
	...fields,
})

/** Checkout with errors: the charge call times out, the page logs it and retries. */
const failedCharge = (visit: Visit, base: number, at: number, path: string) => [
	eventRow(visit, base + 3, at + ms(12), {
		Type: "network",
		Url: url(path),
		NetMethod: "POST",
		NetUrl: url("/api/checkout"),
		NetStatus: 504,
		NetDurationMs: 30_000,
	}),
	eventRow(visit, base + 4, at + ms(42), {
		Type: "error",
		Url: url(path),
		Level: "error",
		Message: "PaymentError: charge timed out after 30000ms",
		ErrorStack: "PaymentError: charge timed out after 30000ms\n    at submitOrder (checkout.tsx:88:11)",
	}),
	eventRow(visit, base + 5, at + ms(43), {
		Type: "console",
		Url: url(path),
		Level: "warn",
		Message: "Retrying checkout (attempt 2)",
	}),
]

/** Per page: the navigation, a click and maybe a custom event. */
const eventRows = (visit: Visit): ReadonlyArray<WarehouseRow> =>
	visit.path.flatMap((path, index) => {
		const at = visit.startMs + (offsets(visit)[index] ?? 0)
		const custom = visit.custom[index]
		const base = index * 10
		return [
			eventRow(visit, base, at, { Type: "navigation", Url: url(path) }),
			eventRow(visit, base + 1, at + ms(6), {
				Type: "click",
				Url: url(path),
				TargetSelector: "button.primary",
				TargetText: path === "/cart" ? "Checkout" : "Add to cart",
			}),
			...(custom === undefined
				? []
				: [
						eventRow(visit, base + 2, at + ms(7), {
							Type: "custom",
							Url: url(path),
							Message: custom,
						}),
					]),
			...(path === "/checkout" && visit.errors > 0 ? failedCharge(visit, base, at, path) : []),
		]
	})

export interface WebSessionRows {
	readonly session_replays: ReadonlyArray<WarehouseRow>
	readonly session_events: ReadonlyArray<WarehouseRow>
	readonly session_replay_events: ReadonlyArray<WarehouseRow>
}

export const webSessionRows = (nowMs: number): WebSessionRows => {
	const all = visits(nowMs)
	const recorded = makePrng(4343)
	const featured = all.filter((visit) => visit.id === FEATURED_SESSION_ID)
	return {
		session_replays: all.map((visit) =>
			replayRow(visit, visit.id === FEATURED_SESSION_ID || recorded.chance(0.6)),
		),
		session_events: all.flatMap(eventRows),
		session_replay_events: featured.flatMap((visit) =>
			featuredRecording({
				orgId: ACME_WEB_ORG,
				sessionId: visit.id,
				host: HOST,
				startMs: visit.startMs,
				offsets: offsets(visit),
				paths: visit.path,
			}),
		),
	}
}
