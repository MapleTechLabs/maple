import { describe, expect, test } from "vitest"
import { isNavItemActive, type NavFlags, navGroups, navPreview, partitionSubItems } from "./nav"
import { Array as Arr, Option } from "effect"

const infrastructure = Option.getOrUndefined(
	Arr.findFirst(
		Arr.flatMap(
			navGroups({ releases: false, securityAudit: false, statusPages: false, users: false }),
			(group) => group.items,
		),
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
		const off = { releases: false, securityAudit: false, statusPages: false, users: false }
		expect(activeTitles("/anomalies", off)).toEqual(["Alerts"])
		expect(activeTitles("/security/code/findings", off)).toEqual(["Code review"])
		expect(activeTitles("/releases", off)).toEqual(["Services"])
		expect(activeTitles("/status-pages/stp_abc", off)).toEqual(["Services"])
	})

	test("a flagged page with its own row highlights only that row", () => {
		const on = { releases: true, securityAudit: true, statusPages: true, users: true }
		expect(activeTitles("/security", on)).toEqual(["Security"])
		expect(activeTitles("/security/code/runs/run_1", on)).toEqual(["Security"])
		expect(activeTitles("/releases", on)).toEqual(["Releases"])
		expect(activeTitles("/status-pages/stp_abc", on)).toEqual(["Status pages"])
	})
})

describe("navGroups", () => {
	const titles = (flags: NavFlags) =>
		Arr.flatMap(navGroups(flags), (group) => Arr.map(group.items, (item) => item.title))

	test("the Status pages row shows only for an org in the statusPages rollout", () => {
		expect(
			titles({ releases: false, securityAudit: false, statusPages: false, users: false }),
		).not.toContain("Status pages")
		expect(titles({ releases: false, securityAudit: false, statusPages: true, users: false })).toContain(
			"Status pages",
		)
	})

	test("the Users row shows only for an org in the users rollout", () => {
		const off = { releases: false, securityAudit: false, statusPages: false, users: false }
		expect(titles(off)).not.toContain("Users")
		expect(titles({ ...off, users: true })).toContain("Users")
	})
})
