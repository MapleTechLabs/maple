import { sha256Base64Url, type StatusPageOverlayEntry, StatusPageKeys } from "@maple/domain/status-page"
import {
	FIXTURE_NOW,
	FIXTURE_PAGE_ID,
	fixtureComponentId,
	makeIncident,
	makeSnapshot,
} from "@maple/status-page/fixtures"
import { beforeEach, describe, expect, it } from "vitest"
import { sharedHostMatcher } from "./handler"
import { CACHE_FRESH_MS, cacheKey } from "./snapshot"
import {
	type FakeStorage,
	makeFakeStorage,
	overlayEntries,
	postForm,
	publish,
	putOverlayEntry,
	send,
} from "./test-support"
import { Option, Schema, Array as Arr, String as Str } from "effect"

const PAGE = "https://status.acme.example/"

const decodeUptime = Schema.decodeUnknownSync(
	Schema.Struct({
		page: Schema.Struct({ status_url: Schema.String }),
		days: Schema.Number,
		components: Schema.Array(Schema.Struct({ name: Schema.String, days: Schema.Array(Schema.Unknown) })),
	}),
)
const TOKEN = "mstat_correct-horse-battery-staple"

const delayedBanner = (html: string): string =>
	Option.match(Str.match(/<div class="notice" id="delayed"[^>]*>/u)(html), {
		onNone: () => "",
		onSome: (found) => found[0],
	})
const entry = (fields: Partial<StatusPageOverlayEntry> = {}): StatusPageOverlayEntry => ({
	id: "e1",
	at: FIXTURE_NOW - 120_000,
	incidentId: null,
	title: "Checkout failing",
	status: "investigating",
	impact: "critical",
	body: "Posted from the edge",
	componentIds: [fixtureComponentId(0)],
	...fields,
})

describe("serving a page", () => {
	let fake: FakeStorage
	beforeEach(() => {
		fake = makeFakeStorage()
		publish(fake, makeSnapshot())
	})

	it("serves the page from KV with cache and security headers, and warms the colo cache", async () => {
		const response = await send(fake, PAGE)
		const html = await response.text()
		expect(response.status).toBe(200)
		expect(html).toContain("<title>Acme status</title>")
		expect(response.headers.get("cache-control")).toBe(
			"public, max-age=15, stale-while-revalidate=60, stale-if-error=86400",
		)
		expect(response.headers.get("x-content-type-options")).toBe("nosniff")
		const nonce = Option.getOrThrow(
			Option.fromNullishOr(response.headers.get("content-security-policy")).pipe(
				Option.flatMap(Str.match(/script-src 'nonce-([^']+)'/u)),
				Option.flatMapNullishOr((found) => found[1]),
			),
		)
		expect(nonce).toBeDefined()
		expect(html).toContain(`<script nonce="${nonce}">`)
		expect(fake.cache.get(cacheKey("snapshot", FIXTURE_PAGE_ID))?.storedAt).toBe(FIXTURE_NOW)
	})

	it("serves from R2 when KV throws", async () => {
		fake.failing.add("kv")
		const response = await send(fake, PAGE)
		expect(response.status).toBe(200)
		expect(await response.text()).toContain("<title>Acme status</title>")
	})

	it("serves from R2 when the KV snapshot does not decode", async () => {
		fake.kv.set(StatusPageKeys.snapshot(FIXTURE_PAGE_ID), "{not json")
		const response = await send(fake, PAGE)
		expect(response.status).toBe(200)
	})

	it("serves the last cached copy, however old, when KV and R2 both fail", async () => {
		await send(fake, PAGE)
		fake.failing.add("kv")
		fake.failing.add("r2")
		const response = await send(fake, PAGE, { nowMs: FIXTURE_NOW + 3_600_000 })
		const html = await response.text()
		expect(response.status).toBe(200)
		expect(html).toContain("<title>Acme status</title>")
		// An hour without a heartbeat: the page must not pass for live.
		expect(delayedBanner(html)).not.toContain("hidden")
	})

	it("answers 503 when no store has the snapshot", async () => {
		fake.failing.add("r2")
		fake.kv.delete(StatusPageKeys.snapshot(FIXTURE_PAGE_ID))
		expect((await send(fake, PAGE)).status).toBe(503)
	})

	it("answers 404 for an unknown host", async () => {
		const response = await send(fake, "https://nobody.example/")
		expect(response.status).toBe(404)
		expect(await response.text()).toContain("Status page not found")
	})

	it("serves the slug path form on a shared host, with links under the prefix", async () => {
		const response = await send(fake, "https://status.maple.workers.dev/s/acme/")
		const html = await response.text()
		expect(response.status).toBe(200)
		expect(html).toContain(`href="/s/acme/feed.atom"`)
		expect((await send(fake, "https://status.maple.workers.dev/s/unknown/")).status).toBe(404)
	})

	it("asks KV for the shared host once per cache window, not on every slug request", async () => {
		const url = "https://status.maple.workers.dev/s/acme/"
		const hostKey = StatusPageKeys.host("status.maple.workers.dev")
		const hostReads = () => Arr.filter(fake.kvReads, (key) => key === hostKey).length
		expect((await send(fake, url)).status).toBe(200)
		expect((await send(fake, url)).status).toBe(200)
		expect(hostReads()).toBe(1)
		expect((await send(fake, url, { nowMs: FIXTURE_NOW + CACHE_FRESH_MS })).status).toBe(200)
		expect(hostReads()).toBe(2)
	})

	it("serves a host that gains a page once its remembered miss has aged out", async () => {
		const page = "https://status.late.example/"
		expect((await send(fake, page)).status).toBe(404)
		fake.kv.set(StatusPageKeys.host("status.late.example"), FIXTURE_PAGE_ID)
		expect((await send(fake, page, { nowMs: FIXTURE_NOW + CACHE_FRESH_MS })).status).toBe(200)
	})

	it("keeps a host's own page ahead of the slug path, so it never serves another page", async () => {
		expect((await send(fake, "https://status.acme.example/s/acme/")).status).toBe(404)
	})

	it("stops serving a renamed page under its old slug", async () => {
		fake.kv.set(StatusPageKeys.slug("old-acme"), FIXTURE_PAGE_ID)
		expect((await send(fake, "https://status.maple.workers.dev/s/old-acme/")).status).toBe(404)
	})

	it("merges break-glass entries listed from their per-entry keys into the page", async () => {
		putOverlayEntry(fake, entry())
		putOverlayEntry(
			fake,
			entry({
				id: "e2",
				at: FIXTURE_NOW - 60_000,
				incidentId: "bg-e1",
				title: null,
				status: null,
				impact: null,
				body: "Still looking",
			}),
		)
		const html = await (await send(fake, PAGE)).text()
		expect(html).toContain("We're experiencing a major outage")
		expect(html).toContain("Checkout failing")
		expect(html).toContain("Posted from the edge")
		expect(html).toContain("Still looking")
	})

	it("lists the overlay at most every 10 seconds per colo", async () => {
		await send(fake, PAGE)
		putOverlayEntry(fake, entry())
		expect(await (await send(fake, PAGE, { nowMs: FIXTURE_NOW + 5_000 })).text()).not.toContain(
			"Checkout failing",
		)
		expect(await (await send(fake, PAGE, { nowMs: FIXTURE_NOW + 11_000 })).text()).toContain(
			"Checkout failing",
		)
	})

	it("keeps a post that lands while a page load is listing the overlay", async () => {
		await send(fake, PAGE)
		const later = FIXTURE_NOW + 11_000
		// A post in this colo writes its entry and the cache after the list has read the keys.
		fake.duringList.run = () => {
			const raced = entry({ id: "raced", at: later, title: "Raced post" })
			putOverlayEntry(fake, raced)
			fake.cache.set(cacheKey("overlay", FIXTURE_PAGE_ID), {
				value: JSON.stringify({ entries: [raced] }),
				storedAt: later,
			})
		}
		await send(fake, PAGE, { nowMs: later })
		expect(await (await send(fake, PAGE, { nowMs: later + 1_000 })).text()).toContain("Raced post")
	})

	it("serves the slug route from R2 when KV throws", async () => {
		fake.failing.add("kv")
		const response = await send(fake, "https://status.maple.workers.dev/s/acme/")
		expect(response.status).toBe(200)
		expect(await response.text()).toContain("<title>Acme status</title>")
	})

	it("answers an uncached 503, not a 404, when KV and R2 both fail on lookup", async () => {
		fake.failing.add("kv")
		fake.failing.add("r2")
		const byHost = await send(fake, PAGE)
		expect(byHost.status).toBe(503)
		expect(byHost.headers.get("cache-control")).toBe("no-store")
		const bySlug = await send(fake, "https://status.maple.workers.dev/s/acme/")
		expect(bySlug.status).toBe(503)
		expect(bySlug.headers.get("cache-control")).toBe("no-store")
	})

	it("shows the delayed banner when the heartbeat is old, and hides it when fresh", async () => {
		expect(delayedBanner(await (await send(fake, PAGE)).text())).toContain("hidden")
		const stale = makeFakeStorage()
		publish(stale, makeSnapshot({ generatedAt: FIXTURE_NOW - 20 * 60_000 }), {
			heartbeatAt: FIXTURE_NOW - 20 * 60_000,
		})
		const html = await (await send(stale, PAGE)).text()
		expect(delayedBanner(html)).not.toContain("hidden")
		expect(html).toContain("Live checks are delayed")
	})

	it("serves daily uptime as public JSON, cached like status.json", async () => {
		const response = await send(fake, `${PAGE}api/v1/uptime.json?days=7`)
		expect(response.status).toBe(200)
		expect(response.headers.get("access-control-allow-origin")).toBe("*")
		expect(response.headers.get("cache-control")).toBe(
			(await send(fake, `${PAGE}api/v1/status.json`)).headers.get("cache-control"),
		)
		const json = decodeUptime(await response.json())
		expect(json.page.status_url).toBe("https://status.acme.example")
		// The fixture's third component has no monitor: it has no uptime to report.
		expect(Arr.map(json.components, (component) => component.name)).toEqual(["API", "Dashboard"])
		expect(Arr.map(json.components, (component) => component.days.length)).toEqual([7, 7])

		const one = decodeUptime(
			await (await send(fake, `${PAGE}api/v1/uptime.json?component=${fixtureComponentId(1)}`)).json(),
		)
		expect(Arr.map(one.components, (component) => component.name)).toEqual(["Dashboard"])
		expect(one.days).toBe(90)
	})

	it("refuses a bad window and an id with no uptime, as JSON", async () => {
		for (const days of ["0", "366", "7.5", "week"]) {
			const response = await send(fake, `${PAGE}api/v1/uptime.json?days=${days}`)
			expect(response.status).toBe(400)
			expect(await response.json()).toEqual({ error: "days must be a whole number from 1 to 365." })
		}
		const missing = await send(fake, `${PAGE}api/v1/uptime.json?component=${fixtureComponentId(2)}`)
		expect(missing.status).toBe(404)
		expect(missing.headers.get("access-control-allow-origin")).toBe("*")
	})

	it("serves status.json, the badge and the feed", async () => {
		const json = await send(fake, `${PAGE}api/v1/status.json`)
		expect(json.headers.get("content-type")).toBe("application/json; charset=utf-8")
		expect(await json.json()).toMatchObject({ status: { indicator: "none", delayed: false } })

		const badge = await send(fake, `${PAGE}badge.svg`)
		expect(badge.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8")
		expect(await badge.text()).toContain(">operational</text>")

		const feed = await send(fake, `${PAGE}feed.atom`)
		expect(await feed.text()).toContain(`<link rel="self" href="https://status.acme.example/feed.atom"/>`)

		const rss = await send(fake, `${PAGE}feed.rss`)
		expect(rss.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8")
		expect(rss.headers.get("cache-control")).toBe(feed.headers.get("cache-control"))
		expect(await rss.text()).toContain(
			`<atom:link href="https://status.acme.example/feed.rss" rel="self"`,
		)
	})

	it("serves the RSS feed under the slug path with links under the prefix", async () => {
		const rss = await send(fake, "https://status.maple.workers.dev/s/acme/feed.rss")
		expect(rss.status).toBe(200)
		expect(await rss.text()).toContain("<link>https://status.maple.workers.dev/s/acme/</link>")
	})

	it("answers /_health without touching storage", async () => {
		fake.failing.add("kv")
		fake.failing.add("r2")
		fake.failing.add("cache")
		const response = await send(fake, "https://anything.example/_health")
		expect(response.status).toBe(200)
		expect(await response.text()).toBe("ok")
	})
})

describe("break-glass updates", () => {
	let fake: FakeStorage
	beforeEach(async () => {
		fake = makeFakeStorage()
		publish(
			fake,
			makeSnapshot({
				breakGlassTokenSha256: await sha256Base64Url(TOKEN),
				incidents: [makeIncident("open")],
			}),
		)
	})

	const update = (token: string, extra: ReadonlyArray<readonly [string, string]> = []) =>
		postForm(`${PAGE}_manage`, [
			["token", token],
			["incidentId", "new"],
			["title", "Payments down"],
			["status", "investigating"],
			["impact", "major"],
			["body", "We are on it"],
			["componentIds", fixtureComponentId(0)],
			...extra,
		])

	it("keeps an earlier post on the page when a lagging KV list has not returned it yet", async () => {
		expect((await send(fake, update(TOKEN))).status).toBe(303)
		// The first post's key is in KV but missing from `list`, as right after a write in another colo.
		fake.kv.forEach((_, key) => Str.startsWith("overlay:")(key) && fake.unlisted.add(key))
		const second = postForm(`${PAGE}_manage`, [
			["token", TOKEN],
			["incidentId", "new"],
			["title", "Checkout down"],
			["body", "Also looking at checkout"],
		])
		expect((await send(fake, second)).status).toBe(303)
		const html = await (await send(fake, PAGE)).text()
		expect(html).toContain("Payments down")
		expect(html).toContain("Checkout down")
	})

	it("serves the form uncached", async () => {
		const response = await send(fake, `${PAGE}_manage`)
		expect(response.headers.get("cache-control")).toBe("no-store")
		expect(await response.text()).toContain(`<option value="open" data-kind="incident">`)
	})

	it("rejects a wrong token and saves nothing", async () => {
		const response = await send(fake, update("mstat_wrong"))
		expect(response.status).toBe(403)
		expect(await response.text()).toContain("That token is not valid for this page.")
		expect(overlayEntries(fake)).toEqual([])
	})

	it("rejects every token when the page has none issued", async () => {
		publish(fake, makeSnapshot())
		fake.cache.clear()
		expect((await send(fake, update(TOKEN))).status).toBe(403)
	})

	it("appends an entry with the right token and redirects to the page, which then shows it", async () => {
		const response = await send(fake, update(TOKEN))
		expect(response.status).toBe(303)
		expect(response.headers.get("location")).toBe("/")
		const entries = overlayEntries(fake)
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({
			at: FIXTURE_NOW,
			incidentId: null,
			title: "Payments down",
			status: "investigating",
			impact: "major",
			body: "We are on it",
			componentIds: [fixtureComponentId(0)],
		})
		const html = await (await send(fake, PAGE)).text()
		expect(html).toContain("Payments down")
		expect(html).toContain("We are on it")
	})

	it("updates an existing incident by id", async () => {
		await send(
			fake,
			postForm(`${PAGE}_manage`, [
				["token", TOKEN],
				["incidentId", "open"],
				["title", ""],
				["status", "resolved"],
				["impact", "minor"],
				["body", "Fixed"],
			]),
		)
		expect(overlayEntries(fake)[0]).toMatchObject({ incidentId: "open", title: null, status: "resolved" })
	})

	it("rejects invalid input: unknown status, empty body, overlong title, unknown component", async () => {
		const bad = [
			[["status", "on_fire"]],
			[["body", ""]],
			[["title", Str.repeat(201)("x")]],
			[["componentIds", "not-a-component"]],
		] as const
		const statuses = await Promise.all(
			Arr.map(bad, async (fields) => {
				const form = new Map<string, string>([
					["token", TOKEN],
					["incidentId", "new"],
					["title", "Payments down"],
					["status", "investigating"],
					["impact", "major"],
					["body", "We are on it"],
					...fields,
				])
				return (await send(fake, postForm(`${PAGE}_manage`, [...form]))).status
			}),
		)
		expect(statuses).toEqual([400, 400, 400, 400])
		expect(overlayEntries(fake)).toEqual([])
	})

	it("says the update was not saved when the KV write fails", async () => {
		fake.failing.add("kv-put")
		const response = await send(fake, update(TOKEN))
		expect(response.status).toBe(503)
		expect(await response.text()).toContain("The update was not saved")
	})

	it("is rate limited per IP and page", async () => {
		fake.limits.allow = false
		const response = await send(fake, update(TOKEN))
		expect(response.status).toBe(429)
		expect(fake.limits.keys).toEqual([`203.0.113.7:${FIXTURE_PAGE_ID}`])
		expect(overlayEntries(fake)).toEqual([])
	})

	it("refuses once the page holds the maximum number of listed entry keys", async () => {
		Array.from({ length: 49 }, (_, index) => putOverlayEntry(fake, entry({ id: `e${index}` })))
		// A corrupt key still counts toward the cap.
		fake.kv.set(StatusPageKeys.overlayEntry(FIXTURE_PAGE_ID, "corrupt"), "{not json")
		expect((await send(fake, update(TOKEN))).status).toBe(409)
		expect(overlayEntries(fake)).toHaveLength(49)
	})

	it("keeps critical impact and the status on a No change follow-up", async () => {
		publish(
			fake,
			makeSnapshot({
				breakGlassTokenSha256: await sha256Base64Url(TOKEN),
				incidents: [makeIncident("open", { impact: "critical", status: "identified" })],
			}),
		)
		const response = await send(
			fake,
			postForm(`${PAGE}_manage`, [
				["token", TOKEN],
				["incidentId", "open"],
				["title", ""],
				["status", ""],
				["impact", ""],
				["body", "Still working on it"],
			]),
		)
		expect(response.status).toBe(303)
		expect(overlayEntries(fake)[0]).toMatchObject({ status: null, impact: null })
		const json = await (await send(fake, `${PAGE}api/v1/status.json`)).json()
		expect(json).toMatchObject({ incidents: [{ id: "open", impact: "critical", status: "identified" }] })
	})

	it("opens a new incident as investigating and major when status and impact say No change", async () => {
		await send(
			fake,
			postForm(`${PAGE}_manage`, [
				["token", TOKEN],
				["incidentId", "new"],
				["title", "Payments down"],
				["status", ""],
				["impact", ""],
				["body", "We are on it"],
			]),
		)
		expect(overlayEntries(fake)[0]).toMatchObject({ status: "investigating", impact: "major" })
	})

	it("rejects a status that does not fit the incident's kind", async () => {
		publish(
			fake,
			makeSnapshot({
				breakGlassTokenSha256: await sha256Base64Url(TOKEN),
				incidents: [
					makeIncident("planned", {
						kind: "maintenance",
						status: "scheduled",
						scheduledStart: FIXTURE_NOW + 86_400_000,
						scheduledEnd: FIXTURE_NOW + 90_000_000,
					}),
				],
			}),
		)
		const post = (incidentId: string, status: string) =>
			send(
				fake,
				postForm(`${PAGE}_manage`, [
					["token", TOKEN],
					["incidentId", incidentId],
					["title", "Payments down"],
					["status", status],
					["impact", ""],
					["body", "b"],
				]),
			)
		expect((await post("planned", "resolved")).status).toBe(400)
		expect((await post("new", "in_progress")).status).toBe(400)
		expect(overlayEntries(fake)).toEqual([])
		expect((await post("planned", "in_progress")).status).toBe(303)
	})

	it("answers 413 to an oversized body sent chunked, without a content-length", async () => {
		const chunk = new TextEncoder().encode(`body=${Str.repeat(8 * 1024)("x")}`)
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				Array.from({ length: 5 }, () => controller.enqueue(chunk))
				controller.close()
			},
		})
		const init: RequestInit & { duplex: "half" } = {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: stream,
			duplex: "half",
		}
		const request = new Request(`${PAGE}_manage`, init)
		expect(request.headers.get("content-length")).toBeNull()
		expect((await send(fake, request)).status).toBe(413)
		expect(overlayEntries(fake)).toEqual([])
	})

	it("dedupes repeated component ids", async () => {
		await send(
			fake,
			update(TOKEN, [
				["componentIds", fixtureComponentId(0)],
				["componentIds", fixtureComponentId(1)],
			]),
		)
		expect(overlayEntries(fake)[0]?.componentIds).toEqual([fixtureComponentId(0), fixtureComponentId(1)])
	})
})

describe("custom domains", () => {
	const CUSTOM = "https://status.acme.com"
	let fake: FakeStorage
	beforeEach(() => {
		fake = makeFakeStorage()
		publish(fake, makeSnapshot({ page: { ...makeSnapshot().page, customDomain: "status.acme.com" } }), {
			host: "status.acme.com",
		})
	})

	it("serves the page and every route of it on the custom domain", async () => {
		const page = await send(fake, `${CUSTOM}/`)
		expect(page.status).toBe(200)
		expect(await page.text()).toContain("<title>Acme status</title>")
		for (const path of ["/feed.atom", "/feed.rss", "/api/v1/status.json", "/badge.svg", "/_manage"])
			expect((await send(fake, `${CUSTOM}${path}`)).status, path).toBe(200)
	})

	it("links feeds, status.json and the Slack command to the custom domain, wherever the page is read", async () => {
		const viaSlug = "https://status.maple.workers.dev/s/acme"
		expect(await (await send(fake, `${viaSlug}/feed.atom`)).text()).toContain(
			`<link rel="self" href="${CUSTOM}/feed.atom"/>`,
		)
		expect(await (await send(fake, `${viaSlug}/feed.rss`)).text()).toContain(`<link>${CUSTOM}/</link>`)
		expect(await (await send(fake, `${viaSlug}/api/v1/status.json`)).json()).toMatchObject({
			page: { status_url: CUSTOM },
		})
		const html = await (await send(fake, `${viaSlug}/`)).text()
		expect(html).toContain(`/feed subscribe ${CUSTOM}/feed.rss`)
		expect(html).toContain(`<link rel="canonical" href="${CUSTOM}/">`)
		expect(html).toContain(`<meta property="og:url" content="${CUSTOM}/">`)
		expect(await (await send(fake, `${viaSlug}/api/v1/uptime.json`)).json()).toMatchObject({
			page: { status_url: CUSTOM },
		})
	})

	it("answers 404 on a host with no page, and never serves another page by path there", async () => {
		const unknown = await send(fake, "https://status.other.com/")
		expect(unknown.status).toBe(404)
		const bySlug = await send(fake, "https://status.other.com/s/acme/")
		expect(bySlug.status).toBe(404)
		// A page's own domain does not serve /s/<slug> of any page either.
		expect((await send(fake, `${CUSTOM}/s/acme/`)).status).toBe(404)
	})
})

describe("sharedHostMatcher", () => {
	const isShared = sharedHostMatcher("status.maple.dev")

	it.each([
		["status.maple.dev", true],
		["STATUS.Maple.Dev", true],
		["status.maple.dev.evil.com", false],
		["evil-status.maple.dev", false],
	])("treats %s as shared: %s", (hostname, shared) => {
		expect(isShared(hostname)).toBe(shared)
	})
})
