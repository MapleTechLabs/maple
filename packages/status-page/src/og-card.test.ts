import {
	DEFAULT_STATUS_PAGE_THEME,
	resolveStatusPageTheme,
	type StatusPageFreshness,
	type StatusPageTheme,
} from "@maple/domain/status-page"
import { Option, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import {
	FIXTURE_NOW,
	fixtureComponentId,
	makeComponent,
	makeDays,
	makeIncident,
	makeSnapshot,
} from "./fixtures"
import { statusOgAlt, statusOgCard, statusOgCardVersion } from "./og-card"
import { renderPage } from "./page"

const live: StatusPageFreshness = { _tag: "live", updatedAt: FIXTURE_NOW }

const withTheme = (theme: Partial<StatusPageTheme>, page: Record<string, unknown> = {}) =>
	makeSnapshot({
		page: { ...makeSnapshot().page, theme: { ...DEFAULT_STATUS_PAGE_THEME, ...theme }, ...page },
	})

const ogImageUrl = (html: string): string | null =>
	Option.getOrNull(
		Option.flatMap(Str.match(/<meta property="og:image" content="([^"]+)">/u)(html), (found) =>
			Option.fromNullishOr(found[1]),
		),
	)

describe("the status card", () => {
	it("says all is well, with the uptime window, when nothing is wrong", () => {
		const card = statusOgCard(makeSnapshot(), live, "status.acme.example")
		expect(card.status).toBe("operational")
		expect(card.headline).toBe("We're fully operational")
		expect(card.details).toEqual([])
		expect(card.days).toHaveLength(90)
		expect(card.uptime).toBe("100%")
	})

	it("names active incidents, counting the ones that do not fit", () => {
		const snapshot = makeSnapshot({
			components: [makeComponent(0, { name: "API", status: "major_outage" })],
			incidents: [
				makeIncident("a", { title: "API errors" }),
				makeIncident("b", { title: "Slow webhooks" }),
				makeIncident("c", { title: "Login failures" }),
			],
		})
		const card = statusOgCard(snapshot, live, null)
		expect(card.headline).toBe("We're experiencing a major outage")
		expect(card.details).toEqual(["API errors"])
		expect(card.moreDetails).toBe(2)
	})

	it("names the affected components when no incident is posted", () => {
		const snapshot = makeSnapshot({ components: [makeComponent(0, { name: "API", status: "degraded" })] })
		expect(statusOgCard(snapshot, live, null).details).toEqual(["API: Degraded performance"])
	})

	it("marks each day by its worst component, and rounds uptime down", () => {
		const snapshot = makeSnapshot({
			components: [
				makeComponent(0, { days: makeDays(FIXTURE_NOW, { 89: "degraded" }) }),
				makeComponent(1, { days: makeDays(FIXTURE_NOW, { 89: "down" }) }),
			],
		})
		const card = statusOgCard(snapshot, live, null)
		expect(card.days.at(-1)).toBe("down")
		expect(card.days.at(0)).toBe("ok")
		expect(card.uptime).toBe("99.98%")
	})

	it("marks the days a component's incidents touched, as the page's bars do", () => {
		const snapshot = makeSnapshot({
			components: [makeComponent(0), makeComponent(1)],
			incidentHistory: [
				{
					id: "db",
					title: "Database upgrade",
					kind: "maintenance",
					impact: "none",
					startedAt: Date.UTC(2026, 9, 27, 2),
					resolvedAt: Date.UTC(2026, 9, 27, 3),
					componentIds: [fixtureComponentId(1)],
				},
			],
		})
		const card = statusOgCard(snapshot, live, null)
		expect(card.days.slice(-3)).toEqual(["ok", "maintenance", "ok"])
	})

	it("reads uptime as the page does, without a float error costing a hundredth", () => {
		const today = makeDays(FIXTURE_NOW, {}, 1)[0]?.day ?? ""
		const days = [{ day: today, checks: 10_000, failures: 3, downChecks: 3 }]
		const snapshot = makeSnapshot({ components: [makeComponent(0, { days })] })
		expect(statusOgCard(snapshot, live, null).uptime).toBe("99.97%")
	})

	it("counts uptime over the 90 days it shows, not the year the snapshot carries", () => {
		const year = makeDays(FIXTURE_NOW, { 0: "down", 1: "down" }, 365)
		const snapshot = makeSnapshot({ components: [makeComponent(0, { days: year })] })
		expect(statusOgCard(snapshot, live, null).uptime).toBe("100%")
	})

	it("draws no uptime strip for components that record no days, as the page does", () => {
		const snapshot = makeSnapshot({ components: [makeComponent(0, { monitored: false, days: [] })] })
		const card = statusOgCard(snapshot, live, null)
		expect(card.days).toEqual([])
		expect(card.uptime).toBeNull()
	})

	it("draws no uptime strip when no component shows uptime", () => {
		const snapshot = makeSnapshot({ components: [makeComponent(0, { showUptime: false })] })
		const card = statusOgCard(snapshot, live, null)
		expect(card.days).toEqual([])
		expect(card.uptime).toBeNull()
	})

	it("says when live checks are delayed, in the image and its alt text", () => {
		const card = statusOgCard(makeSnapshot(), { _tag: "delayed", updatedAt: FIXTURE_NOW }, null)
		expect(card.delayed).toBe(true)
		expect(statusOgAlt(card)).toContain("Live checks delayed")
		expect(statusOgAlt(statusOgCard(makeSnapshot(), live, null))).not.toContain("delayed")
	})

	it("draws a forced dark theme in its dark colours and dark logo, and auto in light", () => {
		const logos = {
			logoUrl: "https://acme.example/light.png",
			logoDarkUrl: "https://acme.example/dark.png",
		}
		const theme = { preset: "midnight", appearance: "dark", font: "serif" } as const
		const dark = statusOgCard(withTheme(theme, logos), live, null)
		expect(dark.tokens.bg).toBe(
			resolveStatusPageTheme({ ...DEFAULT_STATUS_PAGE_THEME, ...theme }).dark.bg,
		)
		expect(dark.logoUrl).toBe(logos.logoDarkUrl)
		expect(dark.font).toBe("serif")

		const auto = statusOgCard(withTheme({ preset: "midnight", appearance: "auto" }, logos), live, null)
		expect(auto.tokens.bg).toBe(
			resolveStatusPageTheme({ ...DEFAULT_STATUS_PAGE_THEME, preset: "midnight" }).light.bg,
		)
		expect(auto.logoUrl).toBe(logos.logoUrl)
	})

	it("never hands the renderer a logo that is not https", () => {
		const card = statusOgCard(withTheme({}, { logoUrl: "http://acme.example/logo.png" }), live, null)
		expect(card.logoUrl).toBeNull()
	})

	it("changes version when the status changes, and only then", () => {
		const calm = statusOgCardVersion(statusOgCard(makeSnapshot(), live, null))
		expect(statusOgCardVersion(statusOgCard(makeSnapshot(), live, null))).toBe(calm)
		const down = makeSnapshot({ components: [makeComponent(0, { status: "major_outage" })] })
		expect(statusOgCardVersion(statusOgCard(down, live, null))).not.toBe(calm)
	})
})

describe("the page's preview tags", () => {
	const publicUrl = "https://status.acme.example"

	it("point at the drawn card under its current version, as a large image", () => {
		const html = renderPage(makeSnapshot(), live, FIXTURE_NOW, { publicUrl })
		const version = statusOgCardVersion(statusOgCard(makeSnapshot(), live, "status.acme.example"))
		expect(ogImageUrl(html)).toBe(`${publicUrl}/og.png?v=${version}`)
		expect(html).toContain(`<meta name="twitter:card" content="summary_large_image">`)
		expect(html).toContain(`<meta property="og:image:width" content="1200">`)
	})

	it("move to a new image URL when an incident opens", () => {
		const before = ogImageUrl(renderPage(makeSnapshot(), live, FIXTURE_NOW, { publicUrl }))
		const incident = makeSnapshot({ incidents: [makeIncident("a", { title: "API errors" })] })
		const after = ogImageUrl(renderPage(incident, live, FIXTURE_NOW, { publicUrl }))
		expect(after).not.toBe(before)
	})

	it("are left out of a page behind a password", () => {
		const html = renderPage(withTheme({}, { visibility: "password" }), live, FIXTURE_NOW, { publicUrl })
		expect(ogImageUrl(html)).toBeNull()
	})
})
