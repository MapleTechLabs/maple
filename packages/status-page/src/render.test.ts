import type { StatusPageComponentStatus } from "@maple/domain/primitives"
import type { StatusPageFreshness } from "@maple/domain/status-page"
import { describe, expect, it } from "vitest"
import {
	FIXTURE_NOW,
	fixtureComponentId,
	makeComponent,
	makeDays,
	makeIncident,
	makeSnapshot,
} from "./fixtures"
import { renderAtomFeed, renderBadgeSvg, renderManagePage, renderPage, renderStatusJson } from "./index"

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
})

const hostileSnapshot = makeSnapshot({
	page: {
		name: HOSTILE,
		slug: "acme",
		description: HOSTILE,
		websiteUrl: "javascript:alert(1)",
		logoUrl: "http://insecure.example/logo.png",
		brandColor: "red;}body{display:none",
		showPoweredBy: false,
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
		expect(html.match(/<script/gu)).toHaveLength(1)
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

	it("draws no bars for a component that hides uptime", () => {
		const html = renderPage(makeSnapshot(), live, FIXTURE_NOW)
		expect(barsOf(html, fixtureComponentId(2))).toHaveLength(0)
		expect(barsOf(html, fixtureComponentId(0))).toHaveLength(90)
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
		const section = (id: string) => html.split(`id="h-${id}"`)[1]?.split("<section")[0] ?? ""
		expect(html).toContain("<h1>Partial system outage</h1>")
		expect(section("active")).toContain("Elevated errors")
		expect(section("active")).toContain("We found the cause")
		expect(section("upcoming")).toContain("Database upgrade")
		expect(section("past")).toContain("Login outage")
		expect(section("past")).not.toContain("Elevated errors")
		expect(html).toContain("Updated 2 min ago")
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
				/<option value="([^"]+)">/gu,
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
})
