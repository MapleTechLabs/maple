import { describe, expect, test } from "vitest"
import { isNavItemActive, type NavFlags, navGroups, navPreview, partitionSubItems } from "./nav"
import { Array as Arr, Option } from "effect"

const OFF: NavFlags = {
	cloudCost: false,
	productAnalytics: false,
	releases: false,
	securityAudit: false,
	statusPages: false,
}

const infrastructure = Option.getOrUndefined(
	Arr.findFirst(
		Arr.flatMap(navGroups(OFF), (group) => group.items),
		(item) => item.title === "Infrastructure",
	),
)
const subItems = infrastructure?.subItems ?? []
const previewFor = (surfaces: ReadonlyArray<"aws" | "railway" | "hosts"> | null) => {
	if (infrastructure === undefined) return undefined
	const { shown } = partitionSubItems(subItems, surfaces === null ? null : new Set(surfaces), "/")
	return navPreview(infrastructure, shown)
}

describe("navPreview", () => {
	test("shows only the sources an org reports", () => {
		const preview = previewFor(["aws", "railway"])
		expect(Arr.map(preview?.glyphs ?? [], (sub) => sub.title)).toEqual(["Railway", "AWS"])
		expect(preview?.overflow).toBe(0)
	})

	test("with nothing reporting, shows every source and counts the ones past the cap", () => {
		for (const preview of [previewFor([]), previewFor(null)]) {
			const total = (preview?.glyphs.length ?? 0) + (preview?.overflow ?? 0)
			expect(total).toBe(Arr.filter(subItems, (sub) => sub.href !== "/infra").length)
			expect(preview?.overflow).toBeGreaterThan(0)
		}
	})
})

describe("isNavItemActive", () => {
	const activeTitles = (path: string, flags: NavFlags) =>
		Arr.map(
			Arr.filter(
				Arr.flatMap(navGroups(flags), (group) => group.items),
				(item) => isNavItemActive(path, item),
			),
			(item) => item.title,
		)

	test("pages without a row of their own highlight their parent row", () => {
		expect(activeTitles("/anomalies", OFF)).toEqual(["Alerts"])
		expect(activeTitles("/security/code/findings", OFF)).toEqual(["Review & CI"])
		expect(activeTitles("/releases", OFF)).toEqual(["Services"])
		expect(activeTitles("/status-pages/stp_abc", OFF)).toEqual(["Services"])
	})

	test("a flagged page with its own row highlights only that row", () => {
		const on = {
			cloudCost: true,
			productAnalytics: true,
			releases: true,
			securityAudit: true,
			statusPages: true,
		}
		expect(activeTitles("/security", on)).toEqual(["Security"])
		expect(activeTitles("/security/code/runs/run_1", on)).toEqual(["Security"])
		expect(activeTitles("/releases", on)).toEqual(["Releases"])
		expect(activeTitles("/status-pages/stp_abc", on)).toEqual(["Status pages"])
		expect(activeTitles("/cost", on)).toEqual(["Cost"])
	})
})

describe("navGroups for an analyst", () => {
	/** Every page the analyst's sidebar links to: rows, then their sub-rows. */
	const hrefs = (flags: NavFlags) =>
		Arr.dedupe(
			Arr.flatMap(navGroups(flags, "analyst"), (group) =>
				Arr.flatMap(group.items, (item) => [
					item.href,
					...Arr.map(item.subItems ?? [], (sub) => sub.href),
				]),
			),
		)

	test("links to what is wrong and how the product is doing, and to no setup or explorer page", () => {
		expect(hrefs(OFF)).toEqual([
			"/",
			"/alerts",
			"/alerts/uptime",
			"/alerts/slos",
			"/errors",
			"/analytics",
			"/users",
			"/replays",
			"/dashboards",
		])
	})

	test("adds Status pages, Releases and Cost only for an org in each rollout", () => {
		expect(hrefs({ ...OFF, statusPages: true })).toContain("/status-pages")
		expect(hrefs({ ...OFF, releases: true })).toContain("/releases")
		expect(hrefs({ ...OFF, cloudCost: true })).toContain("/cost")
		// Security is an engineer's page, whatever the flag says.
		expect(hrefs({ ...OFF, securityAudit: true })).not.toContain("/security")
	})

	test("marks only Incidents on an uptime page, with its Uptime row", () => {
		const items = Arr.flatMap(navGroups(OFF, "analyst"), (group) => group.items)
		const active = Arr.filter(items, (item) => isNavItemActive("/alerts/uptime", item))
		expect(Arr.map(active, (item) => item.title)).toEqual(["Incidents"])
	})
})

describe("navGroups", () => {
	const titles = (flags: NavFlags) =>
		Arr.flatMap(navGroups(flags), (group) => Arr.map(group.items, (item) => item.title))

	test("the Status pages row shows only for an org in the statusPages rollout", () => {
		expect(titles(OFF)).not.toContain("Status pages")
		expect(titles({ ...OFF, statusPages: true })).toContain("Status pages")
	})

	test("the Product analytics row shows only for an org in the productAnalytics rollout", () => {
		expect(titles(OFF)).not.toContain("Product analytics")
		expect(titles({ ...OFF, productAnalytics: true })).toContain("Product analytics")
	})

	test("the Cost row shows only for an org in the cloudCost rollout, marked Beta under Monitor", () => {
		expect(titles(OFF)).not.toContain("Cost")
		const monitor = Arr.findFirst(
			navGroups({ ...OFF, cloudCost: true }),
			(group) => group.id === "monitor",
		)
		const cost = Option.flatMap(monitor, (group) =>
			Arr.findFirst(group.items, (item) => item.title === "Cost"),
		)
		expect(Option.getOrUndefined(cost)).toMatchObject({ href: "/cost", badge: "Beta" })
	})
})
