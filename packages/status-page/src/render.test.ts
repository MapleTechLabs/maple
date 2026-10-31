import type { StatusPageComponentStatus } from "@maple/domain/primitives"
import {
	DEFAULT_STATUS_PAGE_THEME,
	type StatusPageFreshness,
	type StatusPageSnapshot,
	type StatusPageTheme,
} from "@maple/domain/status-page"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
	FIXTURE_NOW,
	fixtureComponentId,
	makeComponent,
	makeDays,
	makeIncident,
	makeSnapshot,
} from "./fixtures"
import {
	previewSnapshot,
	renderAtomFeed,
	renderBadgeSvg,
	renderManagePage,
	renderPage,
	renderStatusJson,
} from "./index"

const HOSTILE = `<script>alert("x")</script>&'`
const live: StatusPageFreshness = { _tag: "live", updatedAt: FIXTURE_NOW - 2 * 60_000 }
const delayed: StatusPageFreshness = { _tag: "delayed", updatedAt: Date.UTC(2026, 9, 28, 11, 0) }

const update = (
	id: string,
	at: number,
	body: string,
	status: "investigating" | "resolved" = "investigating",
) => ({
	id,
	status,
	body,
	at,
	source: "dashboard" as const,
	overlayEntryId: null,
})

const hostileSnapshot = makeSnapshot({
	page: {
		name: HOSTILE,
		slug: "acme",
		description: HOSTILE,
		websiteUrl: "javascript:alert(1)",
		logoUrl: "http://insecure.example/logo.png",
		theme: DEFAULT_STATUS_PAGE_THEME,
		showPoweredBy: false,
		privacyUrl: "javascript:alert(1)",
		termsUrl: null,
	},
	components: [makeComponent(0, { name: HOSTILE, group: HOSTILE, description: HOSTILE })],
	incidents: [
		makeIncident("inc-1", {
			title: HOSTILE,
			updates: [update("u-1", FIXTURE_NOW - 60_000, HOSTILE)],
		}),
	],
})

/** The `<li>` bars of one component, in order. */
const barsOf = (html: string, componentId: string) => {
	const block = html.split(`data-component="${componentId}"`)[1]?.split(`data-component="`)[0] ?? ""
	return [
		...block.matchAll(/<li class="d-(\w+)" data-day="([^"]+)" data-state="\w+" title="([^"]*)">/gu),
	].map((match) => ({ state: match[1], day: match[2], title: match[3] }))
}

const delayedBanner = (html: string): string =>
	html.match(/<div class="notice" id="delayed"[^>]*>/u)?.[0] ?? ""

describe("renderPage", () => {
	it("escapes every piece of customer text and drops unsafe URLs and colours", () => {
		const html = renderPage(hostileSnapshot, live, FIXTURE_NOW)
		expect(html).not.toContain(`<script>alert`)
		// The nonce'd page script and the inert JSON data block; no customer text opens one.
		expect(html.match(/<script/gu)).toHaveLength(2)
		expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;")
		expect(html).not.toContain("javascript:")
		expect(html).not.toContain("insecure.example")
		expect(html).not.toContain("body{display:none")
	})

	it("hides the delayed banner while checks are live and shows it with the last known time when not", () => {
		const snapshot = makeSnapshot()
		expect(delayedBanner(renderPage(snapshot, live, FIXTURE_NOW))).toContain("hidden")

		const html = renderPage(snapshot, delayed, FIXTURE_NOW)
		expect(delayedBanner(html)).not.toContain("hidden")
		expect(html).toContain("Live checks are delayed. Showing the last known state from")
		expect(html).toContain("Oct 28, 2026, 11:00 UTC")
		expect(html).toContain(`data-updated-at="${delayed.updatedAt}"`)
	})

	it("draws one bar per day coloured by that day's state, with a dated tooltip and the uptime", () => {
		const snapshot = makeSnapshot({
			components: [
				makeComponent(0, { days: makeDays(FIXTURE_NOW, { 0: "none", 88: "degraded", 89: "down" }) }),
			],
		})
		const bars = barsOf(renderPage(snapshot, live, FIXTURE_NOW), fixtureComponentId(0))
		expect(bars).toHaveLength(90)
		expect(bars[0]?.state).toBe("none")
		expect(bars[1]?.state).toBe("ok")
		expect(bars[88]).toEqual({
			state: "degraded",
			day: "2026-10-27",
			title: "Oct 27, 2026: 3 of 1440 checks failed",
		})
		expect(bars[89]).toEqual({
			state: "down",
			day: "2026-10-28",
			title: "Oct 28, 2026: Down during 30 of 1440 checks",
		})
		// 89 checked days, 30 down checks of 128160.
		expect(renderPage(snapshot, live, FIXTURE_NOW)).toContain("99.97% uptime")
	})

	it("draws no bars for a component that hides uptime, even with daily counts", () => {
		const snapshot = makeSnapshot({
			components: [
				makeComponent(0, { showUptime: true, days: makeDays() }),
				makeComponent(1, { showUptime: false, days: makeDays() }),
			],
		})
		const html = renderPage(snapshot, live, FIXTURE_NOW)
		expect(barsOf(html, fixtureComponentId(1))).toHaveLength(0)
		expect(barsOf(html, fixtureComponentId(0))).toHaveLength(90)
	})

	it("offers each status under the lifecycle it belongs to", () => {
		const html = renderManagePage(makeSnapshot())
		const group = (label: string) =>
			[
				...(
					html.match(new RegExp(`<optgroup label="${label}"[^>]*>(.*?)</optgroup>`, "u"))?.[1] ?? ""
				).matchAll(/value="([a-z_]+)"/gu),
			].map((match) => match[1])
		expect(group("For incidents")).toEqual(["investigating", "identified", "monitoring", "resolved"])
		expect(group("For maintenance")).toEqual(["scheduled", "in_progress", "completed"])
	})

	it("tags each target and status group with its kind for the form's script to match", () => {
		const html = renderManagePage(
			makeSnapshot({
				incidents: [
					makeIncident("db", { kind: "maintenance", status: "in_progress", title: "DB upgrade" }),
				],
			}),
		)
		expect(html).toContain(`<option value="new" data-kind="incident">New incident</option>`)
		expect(html).toContain(`<option value="db" data-kind="maintenance">Maintenance: DB upgrade</option>`)
		expect(html).toContain(`<optgroup label="For maintenance" data-kind="maintenance">`)
	})

	it("lists active incidents with updates, upcoming maintenance and past incidents in their sections", () => {
		const snapshot = makeSnapshot({
			components: [makeComponent(0, { status: "partial_outage" })],
			incidents: [
				makeIncident("open", {
					title: "Elevated errors",
					updates: [update("u-2", FIXTURE_NOW - 5 * 60_000, "We found the cause")],
				}),
				makeIncident("planned", {
					kind: "maintenance",
					status: "scheduled",
					title: "Database upgrade",
					scheduledStart: FIXTURE_NOW + 86_400_000,
					scheduledEnd: FIXTURE_NOW + 90_000_000,
				}),
				makeIncident("old", {
					title: "Login outage",
					status: "resolved",
					resolvedAt: FIXTURE_NOW - 86_400_000,
				}),
			],
		})
		const html = renderPage(snapshot, live, FIXTURE_NOW)
		const section = (id: string) => html.split(`id="h-${id}"`)[1]?.split("</section>")[0] ?? ""
		expect(html).toContain("We're experiencing a partial outage")
		expect(section("active")).toContain("Elevated errors")
		expect(section("active")).toContain("We found the cause")
		expect(section("upcoming")).toContain("Database upgrade")
		expect(section("past")).toContain("Login outage")
		expect(section("past")).not.toContain("Elevated errors")
		expect(html).toContain("Updated 2 min ago")
	})
})

const DAY_MS = 86_400_000

const PageData = Schema.Struct({
	end: Schema.String,
	len: Schema.Number,
	windows: Schema.Number,
	bars: Schema.Record(
		Schema.String,
		Schema.Array(
			Schema.Union([Schema.Literal(0), Schema.Tuple([Schema.Number, Schema.Number, Schema.Number])]),
		),
	),
	today: Schema.String,
	entries: Schema.Array(
		Schema.Struct({
			title: Schema.String,
			tone: Schema.String,
			meta: Schema.String,
			href: Schema.NullOr(Schema.String),
		}),
	),
	days: Schema.Record(
		Schema.String,
		Schema.Tuple([Schema.String, Schema.Array(Schema.Number), Schema.String]),
	),
})

/** The JSON the page script pages through, read back the way the browser would. */
const pageDataOf = (html: string) =>
	Schema.decodeUnknownSync(Schema.fromJsonString(PageData))(
		html.match(/<script type="application\/json" id="sp-data">([\s\S]*?)<\/script>/u)?.[1] ?? "",
	)

const heroOf = (html: string): string =>
	html.split(`aria-labelledby="h-hero">`)[1]?.split("</section>")[0] ?? ""
const footerOf = (html: string): string => html.split("<footer>")[1]?.split("</footer>")[0] ?? ""
const rowOf = (html: string, componentId: string): string =>
	html.split(`data-component="${componentId}"`)[1]?.split(`<ol`)[0] ?? ""

describe("renderPage layout", () => {
	const sentences: ReadonlyArray<[StatusPageComponentStatus, string]> = [
		["operational", "We're fully operational"],
		["degraded", "We're experiencing degraded performance"],
		["partial_outage", "We're experiencing a partial outage"],
		["major_outage", "We're experiencing a major outage"],
		["maintenance", "Scheduled maintenance in progress"],
	]
	it.each(sentences)("heads the page with the sentence for %s", (status, sentence) => {
		const html = renderPage(
			makeSnapshot({ components: [makeComponent(0), makeComponent(1, { status })] }),
			live,
			FIXTURE_NOW,
		)
		expect(html).toContain(`<h1 id="h-hero">${sentence}</h1>`)
	})

	it("says all is clear under the banner, or links each active incident", () => {
		const clear = heroOf(renderPage(makeSnapshot(), live, FIXTURE_NOW))
		expect(clear).toContain("We're not aware of any issues affecting our systems.")

		const html = renderPage(
			makeSnapshot({
				incidents: [
					makeIncident("open", { title: "Elevated errors" }),
					makeIncident("old", {
						title: "Gone",
						status: "resolved",
						resolvedAt: FIXTURE_NOW - DAY_MS,
					}),
				],
			}),
			live,
			FIXTURE_NOW,
		)
		const hero = heroOf(html)
		expect(hero).not.toContain("not aware of any issues")
		expect(hero).toContain(`<a href="#incident-open">Elevated errors</a>`)
		expect(hero).not.toContain("Gone")
		expect(html).toContain(`id="incident-open"`)
	})

	it("names the affected components when the banner is not operational and no incident is posted", () => {
		const hero = heroOf(
			renderPage(
				makeSnapshot({
					components: [
						makeComponent(0, { name: "API", status: "major_outage" }),
						makeComponent(1, { name: "Dashboard" }),
					],
				}),
				live,
				FIXTURE_NOW,
			),
		)
		expect(hero).not.toContain("not aware of any issues")
		expect(hero).toContain("Affected: API (Major outage)")
		expect(hero).not.toContain("Dashboard")
	})

	it("puts the uptime of the visible 90 days on the component row, with the status for screen readers", () => {
		// A year of bars: an outage 200 days ago sits outside the latest window and does not count.
		const days = makeDays(FIXTURE_NOW, { 164: "down" }, 365)
		const snapshot = makeSnapshot({
			components: [makeComponent(0, { name: "API", status: "degraded", days })],
		})
		const html = renderPage(snapshot, live, FIXTURE_NOW)
		const row = rowOf(html, fixtureComponentId(0))
		expect(row).toContain("100% uptime")
		expect(row).toContain(`title="Degraded performance"`)
		expect(row).toContain(`<span class="sr">: Degraded performance</span>`)
		expect(html).toContain(`<span id="window-label" aria-live="polite">Jul 2026 - Oct 2026</span>`)

		const recent = makeDays(FIXTURE_NOW, { 300: "down" }, 365)
		const outage = renderPage(
			makeSnapshot({ components: [makeComponent(0, { days: recent })] }),
			live,
			FIXTURE_NOW,
		)
		// 30 down checks in 90 days of 1440.
		expect(rowOf(outage, fixtureComponentId(0))).toContain("99.97% uptime")
	})

	it("renders only the latest window without script, with the arrows hidden until the script shows them", () => {
		const snapshot = makeSnapshot({
			components: [makeComponent(0, { days: makeDays(FIXTURE_NOW, {}, 365) })],
		})
		const html = renderPage(snapshot, live, FIXTURE_NOW)
		const bars = barsOf(html, fixtureComponentId(0))
		expect(bars).toHaveLength(90)
		expect(bars[0]?.day).toBe("2026-07-31")
		expect(bars.at(-1)?.day).toBe("2026-10-28")
		const arrows = html.match(/<button type="button" data-nav="[a-z]+"[^>]*>/gu) ?? []
		expect(arrows).toHaveLength(4)
		expect(arrows.every((arrow) => arrow.includes(" hidden"))).toBe(true)
		const data = pageDataOf(html)
		expect(data.windows).toBe(5)
		expect(data.len).toBe(365)
		expect(data.end).toBe("2026-10-28")
		expect(data.bars[fixtureComponentId(0)]).toHaveLength(365)
	})

	it("names the status of a component that hides uptime, without bars or a percentage", () => {
		const html = renderPage(makeSnapshot(), live, FIXTURE_NOW)
		const docs =
			html.split(`data-component="${fixtureComponentId(2)}"`)[1]?.split("</div></div>")[0] ?? ""
		expect(docs).toContain("Docs")
		expect(docs).toContain(": Operational")
		expect(docs).not.toContain("uptime")
		expect(docs).not.toContain("<ol")
	})

	it("keeps grouped components under their group, in order", () => {
		const html = renderPage(
			makeSnapshot({
				components: [
					makeComponent(0, { name: "API", group: "Platform" }),
					makeComponent(1, { name: "Docs", group: null }),
					makeComponent(2, { name: "Dashboard", group: "Platform", status: "partial_outage" }),
				],
			}),
			live,
			FIXTURE_NOW,
		)
		const groups = html
			.split(`<div class="group">`)
			.slice(1)
			.map((group) =>
				[...group.matchAll(/<span>([^<]+)<\/span><span class="sr">: ([^<]+)</gu)].map(
					(m) => `${m[1]}: ${m[2]}`,
				),
			)
		expect(groups).toEqual([
			["Platform: Partial outage", "API: Operational", "Dashboard: Partial outage"],
			["Docs: Operational"],
		])
	})

	it("marks each day an incident touched, with the worst impact of that day, and today", () => {
		const html = renderPage(
			makeSnapshot({
				incidentHistory: [
					{
						id: "long",
						title: "Login outage",
						kind: "incident",
						impact: "critical",
						startedAt: Date.UTC(2026, 9, 9, 22),
						resolvedAt: Date.UTC(2026, 9, 11, 1),
					},
					{
						id: "small",
						title: "Slow search",
						kind: "incident",
						impact: "minor",
						startedAt: Date.UTC(2026, 9, 12, 9),
						resolvedAt: Date.UTC(2026, 9, 12, 10),
					},
					{
						id: "db",
						title: "Database upgrade",
						kind: "maintenance",
						impact: "none",
						startedAt: Date.UTC(2026, 9, 10, 2),
						resolvedAt: Date.UTC(2026, 9, 10, 3),
					},
				],
			}),
			live,
			FIXTURE_NOW,
		)
		const data = pageDataOf(html)
		const tones = Object.fromEntries(Object.entries(data.days).map(([day, mark]) => [day, mark[0]]))
		expect(tones).toEqual({
			"2026-10-09": "major_outage",
			"2026-10-10": "major_outage",
			"2026-10-11": "major_outage",
			"2026-10-12": "degraded",
		})
		expect(data.days["2026-10-10"]?.[2]).toBe("Oct 10, 2026: 1 incident, 1 maintenance")
		expect(data.entries.map((entry) => [entry.title, entry.meta, entry.href])).toEqual([
			["Slow search", "Minor · Resolved", null],
			["Database upgrade", "Maintenance · Completed", null],
			["Login outage", "Critical · Resolved", null],
		])
		// The current month is drawn on the server: marked days are buttons, today is flagged.
		expect(html).toContain(`aria-label="Oct 11, 2026: 1 incident"`)
		expect(html).toMatch(/<button type="button" class="[^"]*" data-day="2026-10-09"/u)
		expect(html).not.toContain(`data-day="2026-10-13" aria-label`)
		expect(html).toMatch(/<span class="day today" aria-current="date">28<\/span>/u)
		expect(html).toContain(`<span id="month-label" aria-live="polite">Oct 2026</span>`)
	})

	it("links a calendar entry to the incident when the page still lists it", () => {
		const html = renderPage(
			makeSnapshot({
				incidents: [makeIncident("open", { title: "Elevated errors", impact: "major" })],
				incidentHistory: [],
			}),
			live,
			FIXTURE_NOW,
		)
		expect(pageDataOf(html).entries).toEqual([
			{
				title: "Elevated errors",
				tone: "partial_outage",
				meta: "Major · Investigating",
				href: "#incident-open",
			},
		])
	})

	it("keeps a title that closes the script element inside the embedded data", () => {
		const title = `</script><script>alert(1)</script><!--`
		const html = renderPage(
			makeSnapshot({
				incidentHistory: [
					{
						id: "x",
						title,
						kind: "incident",
						impact: "major",
						startedAt: FIXTURE_NOW - DAY_MS,
						resolvedAt: FIXTURE_NOW - DAY_MS + 60_000,
					},
				],
			}),
			live,
			FIXTURE_NOW,
		)
		expect(html).not.toContain("<script>alert(1)")
		expect(html.match(/<script/gu)).toHaveLength(2)
		expect(pageDataOf(html).entries[0]?.title).toBe(title)
	})

	it("credits Maple with its mark, and drops both when the page hides the credit", () => {
		const page = makeSnapshot().page
		const footer = (showPoweredBy: boolean) =>
			footerOf(renderPage(makeSnapshot({ page: { ...page, showPoweredBy } }), live, FIXTURE_NOW))
		expect(footer(true)).toMatch(
			/Powered by <a href="https:\/\/maple.dev" rel="noopener"><svg class="maple-mark"[^>]*aria-hidden="true">/u,
		)
		expect(footer(false)).not.toContain("maple-mark")
		expect(footer(false)).not.toContain("Powered by")
	})

	it("shows the privacy and terms links only when set, and only over https", () => {
		const page = makeSnapshot().page
		const footer = (privacyUrl: string | null, termsUrl: string | null) =>
			footerOf(renderPage(makeSnapshot({ page: { ...page, privacyUrl, termsUrl } }), live, FIXTURE_NOW))
		const none = footer(null, null)
		expect(none).not.toContain("Privacy policy")
		expect(none).not.toContain("Terms of service")
		expect(none).toContain("Atom feed")
		expect(none).toContain("Powered by")

		const both = footer("https://acme.example/privacy", "https://acme.example/terms")
		expect(both).toContain(`<a href="https://acme.example/privacy" rel="noopener">Privacy policy</a>`)
		expect(both).toContain(`<a href="https://acme.example/terms" rel="noopener">Terms of service</a>`)
		expect(footer("http://acme.example/privacy", null)).not.toContain("Privacy policy")
	})
})

describe("renderStatusJson", () => {
	const cases: ReadonlyArray<[StatusPageComponentStatus, string]> = [
		["operational", "none"],
		["degraded", "minor"],
		["partial_outage", "major"],
		["major_outage", "critical"],
		["maintenance", "maintenance"],
	]
	it.each(cases)("maps a worst component of %s to indicator %s", (status, indicator) => {
		const snapshot = makeSnapshot({ components: [makeComponent(0), makeComponent(1, { status })] })
		expect(renderStatusJson(snapshot, live).status.indicator).toBe(indicator)
	})

	it("lists only unresolved incidents and reports a delayed page", () => {
		const snapshot = makeSnapshot({
			incidents: [
				makeIncident("open"),
				makeIncident("done", { status: "resolved", resolvedAt: FIXTURE_NOW }),
			],
		})
		const json = renderStatusJson(snapshot, delayed)
		expect(json.incidents.map((incident) => incident.id)).toEqual(["open"])
		expect(json.status.delayed).toBe(true)
		expect(json.updated_at).toBe("2026-10-28T11:00:00.000Z")
	})
})

describe("renderBadgeSvg", () => {
	it("says the overall status, and delayed when checks are stale", () => {
		const outage = makeSnapshot({ components: [makeComponent(0, { status: "major_outage" })] })
		expect(renderBadgeSvg(outage, live)).toContain(">major outage</text>")
		expect(renderBadgeSvg(outage, delayed)).toContain(">delayed</text>")
		expect(renderBadgeSvg(hostileSnapshot, live)).not.toContain("<script>")
	})
})

describe("renderAtomFeed", () => {
	it("has one entry per update, newest first, with escaped text", () => {
		const snapshot = makeSnapshot({
			incidents: [
				makeIncident("a", {
					title: "Errors & timeouts",
					updates: [
						update("a2", FIXTURE_NOW - 60_000, "Fixed <now>", "resolved"),
						update("a1", FIXTURE_NOW - 600_000, "Looking"),
					],
				}),
				makeIncident("b", { updates: [update("b1", FIXTURE_NOW - 300_000, "Other")] }),
			],
		})
		const xml = renderAtomFeed(snapshot, "https://status.acme.example/")
		const titles = [...xml.matchAll(/<entry>.*?<title>([^<]*)<\/title>/gu)].map((match) => match[1])
		expect(titles).toEqual([
			"Errors &amp; timeouts: Resolved",
			"Incident b: Investigating",
			"Errors &amp; timeouts: Investigating",
		])
		expect(xml).toContain('<content type="text">Fixed &lt;now&gt;</content>')
		expect(xml).toContain('href="https://status.acme.example/#incident-a"')
	})
})

describe("renderManagePage", () => {
	it("offers the active incidents and every component, and escapes the message", () => {
		const snapshot = makeSnapshot({
			incidents: [
				makeIncident("open", { title: "Elevated errors" }),
				makeIncident("old", { title: "Gone", status: "resolved", resolvedAt: FIXTURE_NOW }),
			],
		})
		const html = renderManagePage(snapshot, { tone: "error", text: HOSTILE })
		const incidentOptions = [
			...(html.split(`name="incidentId"`)[1]?.split("</select>")[0] ?? "").matchAll(
				/<option value="([^"]+)"[^>]*>/gu,
			),
		].map((match) => match[1])
		expect(incidentOptions).toEqual(["new", "open"])
		const checkboxes = [...html.matchAll(/name="componentIds" value="([^"]+)"/gu)].map(
			(match) => match[1],
		)
		expect(checkboxes).toEqual([fixtureComponentId(0), fixtureComponentId(1), fixtureComponentId(2)])
		expect(html).not.toContain("<script>alert")
		expect(html).toContain("&lt;script&gt;")
	})

	it("selects No change for status and impact, so a follow-up keeps the incident's values", () => {
		const html = renderManagePage(makeSnapshot({ incidents: [makeIncident("open")] }))
		const selected = (name: string) =>
			[
				...(html.split(`name="${name}"`)[1]?.split("</select>")[0] ?? "").matchAll(
					/<option value="([^"]*)" selected>/gu,
				),
			].map((match) => match[1])
		expect(selected("status")).toEqual([""])
		expect(selected("impact")).toEqual([""])
	})
})

/** A snapshot carrying `theme` as-is, skipping decode the way a corrupted edge copy could. */
const themed = (theme: StatusPageTheme): StatusPageSnapshot => {
	const snapshot = makeSnapshot()
	return { ...snapshot, page: { ...snapshot.page, theme } }
}

const styleOf = (html: string): string => html.match(/<style[^>]*>([\s\S]*?)<\/style>/u)?.[1] ?? ""

describe("page theme", () => {
	it("follows the visitor's scheme in auto, with both token sets", () => {
		const css = styleOf(renderPage(themed(DEFAULT_STATUS_PAGE_THEME), live, FIXTURE_NOW))
		expect(css).toContain("color-scheme:light dark")
		expect(css).toContain("@media (prefers-color-scheme:dark)")
	})

	it("forces dark with one token set, its background and no media query", () => {
		const css = styleOf(
			renderPage(
				themed({ ...DEFAULT_STATUS_PAGE_THEME, appearance: "dark", background: "#101820" }),
				live,
				FIXTURE_NOW,
			),
		)
		expect(css).toContain("color-scheme:dark;")
		expect(css).not.toContain("prefers-color-scheme")
		expect(css).toContain("--bg:#101820")
		expect(css.match(/--bg:/gu)).toHaveLength(1)
	})

	it("ignores the colour overrides in auto but keeps the accent", () => {
		const css = styleOf(
			renderPage(
				themed({
					...DEFAULT_STATUS_PAGE_THEME,
					accent: "#1D4ED8",
					background: "#101820",
					text: "#fedcba",
				}),
				live,
				FIXTURE_NOW,
			),
		)
		expect(css).not.toContain("#101820")
		expect(css).not.toContain("#fedcba")
		// Readable on the light background only, so one mode carries it.
		expect(css.match(/--link:#1d4ed8/gu)).toHaveLength(1)
	})

	it("applies the radius and the font stack", () => {
		const css = styleOf(
			renderPage(
				themed({ ...DEFAULT_STATUS_PAGE_THEME, preset: "paper", radius: "lg", font: "serif" }),
				live,
				FIXTURE_NOW,
			),
		)
		expect(css).toContain("--radius:14px")
		expect(css).toMatch(/--font:ui-serif,Georgia/u)
		expect(css).toContain("font:15px/1.5 var(--font)")
		expect(css).toMatch(/\.card\{[^}]*border-radius:var\(--radius\)/u)
		const square = styleOf(
			renderPage(themed({ ...DEFAULT_STATUS_PAGE_THEME, radius: "none" }), live, FIXTURE_NOW),
		)
		expect(square).toContain("--radius:0px")
	})

	it("drops a hostile value in any theme field instead of letting it reach CSS", () => {
		const hostile = "red;}html{opacity:0}"
		const theme = {
			preset: hostile,
			appearance: "dark",
			accent: hostile,
			background: hostile,
			text: hostile,
			card: `#fff</style><script>alert(1)</script>`,
			border: hostile,
			radius: hostile,
			font: hostile,
		}
		// Typed loosely on purpose: the renderer must cope with what the schema would refuse.
		const snapshot: StatusPageSnapshot = JSON.parse(
			JSON.stringify({ ...makeSnapshot(), page: { ...makeSnapshot().page, theme } }),
		)
		const html = renderPage(snapshot, live, FIXTURE_NOW)
		const css = styleOf(html)
		expect(html).not.toContain("opacity:0")
		expect(html).not.toContain("alert(1)")
		expect(css).toContain("--bg:#000000")
		expect(css).toContain("--radius:8px")
		expect(css).toMatch(/--font:ui-sans-serif/u)
		expect(html).toContain(`<html lang="en" data-preset="default">`)
	})

	it("marks the page with its preset, which sets that preset's card shadow", () => {
		const html = renderPage(themed({ ...DEFAULT_STATUS_PAGE_THEME, preset: "paper" }), live, FIXTURE_NOW)
		expect(html).toContain(`<html lang="en" data-preset="paper">`)
		expect(styleOf(html)).toMatch(/\[data-preset=paper\]\{--shadow:[^}]+\}/u)
	})

	it("shows a monogram in the brand colour when the page has no logo", () => {
		const html = renderPage(
			themed({ ...DEFAULT_STATUS_PAGE_THEME, preset: "midnight" }),
			live,
			FIXTURE_NOW,
		)
		expect(html).toMatch(/<span class="mono-mark" aria-hidden="true">[A-Z]<\/span>/u)
		expect(styleOf(html)).toContain("--primary:#6e56cf")
	})
})

describe("editor preview render", () => {
	const snapshot = makeSnapshot({
		incidents: [makeIncident("inc-1", { componentIds: [fixtureComponentId(0)] })],
	})

	it("tags components and incidents with their ids only when the preview flag is set", () => {
		const html = renderPage(snapshot, live, FIXTURE_NOW, { preview: true })
		expect(html).toContain(`data-component-id="${fixtureComponentId(0)}"`)
		expect(html).toContain(`data-incident-id="inc-1"`)
		const publicHtml = renderPage(snapshot, live, FIXTURE_NOW)
		expect(publicHtml).not.toMatch(/data-(component|incident)-id=/u)
	})

	it("adds nothing else: without the ids the preview is the public page", () => {
		const preview = renderPage(snapshot, live, FIXTURE_NOW, { preview: true })
		expect(preview.replaceAll(/ data-(component|incident)-id="[^"]*"/gu, "")).toBe(
			renderPage(snapshot, live, FIXTURE_NOW),
		)
	})
})

describe("previewSnapshot", () => {
	const base = makeSnapshot()
	const withoutDays = (index: number) => {
		const { days: _days, ...component } = base.components[index]!
		return component
	}

	it("derives statuses from monitors, overrides and active incidents, with empty bars", () => {
		const incident = makeIncident("inc-1", { componentIds: [fixtureComponentId(1)], impact: "major" })
		const snapshot = previewSnapshot({
			pageId: base.pageId,
			page: { ...base.page, theme: { ...DEFAULT_STATUS_PAGE_THEME, accent: "#123abc" } },
			components: [
				{ ...withoutDays(0), monitorStatus: "down", manualStatus: null },
				{ ...withoutDays(1), monitorStatus: "up", manualStatus: null },
				{ ...withoutDays(2), monitorStatus: null, manualStatus: "degraded" },
			],
			incidents: makeSnapshot({ incidents: [incident] }).incidents,
			nowMs: FIXTURE_NOW,
		})
		expect(snapshot.components.map((c) => c.status)).toEqual([
			"major_outage",
			"partial_outage",
			"degraded",
		])
		expect(snapshot.components[1]?.baseStatus).toBe("operational")
		expect(snapshot.components.map((c) => c.days.length)).toEqual([90, 90, 0])
		expect(snapshot.incidentHistory.map((entry) => entry.id)).toEqual(["inc-1"])
		expect(snapshot.components[0]?.days.every((day) => day.checks === 0)).toBe(true)
		const html = renderPage(snapshot, { _tag: "live", updatedAt: FIXTURE_NOW }, FIXTURE_NOW)
		expect(html).toContain("--link:#123abc")
		expect(rowOf(html, snapshot.components[0]!.id)).toContain(`<span class="uptime">No data</span>`)
	})
})

describe("previewSnapshot with history", () => {
	it("shows the days it is given for a monitored component", () => {
		const base = makeSnapshot()
		const days = base.components[0]!.days
		const snapshot = previewSnapshot({
			pageId: base.pageId,
			page: base.page,
			components: [{ ...base.components[0]!, monitorStatus: "up", manualStatus: null, days }],
			incidents: [],
			nowMs: FIXTURE_NOW,
		})
		expect(snapshot.components[0]?.days).toEqual(days)
		expect(renderPage(snapshot, live, FIXTURE_NOW)).toContain("100% uptime")
	})
})
