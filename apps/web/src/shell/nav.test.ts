import { describe, expect, test } from "vitest"
import { isNavItemActive, navGroups, navPreview, partitionSubItems } from "./nav"

const infrastructure = navGroups({ releases: false, securityAudit: false })
	.flatMap((group) => group.items)
	.find((item) => item.title === "Infrastructure")
const subItems = infrastructure?.subItems ?? []
const previewFor = (surfaces: ReadonlyArray<"aws" | "railway" | "hosts"> | null) => {
	if (infrastructure === undefined) return undefined
	const { shown } = partitionSubItems(subItems, surfaces === null ? null : new Set(surfaces), "/")
	return navPreview(infrastructure, shown)
}

describe("navPreview", () => {
	test("shows only the sources an org reports", () => {
		const preview = previewFor(["aws", "railway"])
		expect(preview?.glyphs.map((sub) => sub.title)).toEqual(["Railway", "AWS"])
		expect(preview?.overflow).toBe(0)
	})

	test("with nothing reporting, shows every source and counts the ones past the cap", () => {
		for (const preview of [previewFor([]), previewFor(null)]) {
			const total = (preview?.glyphs.length ?? 0) + (preview?.overflow ?? 0)
			expect(total).toBe(subItems.filter((sub) => sub.href !== "/infra").length)
			expect(preview?.overflow).toBeGreaterThan(0)
		}
	})
})

describe("isNavItemActive", () => {
	const activeTitles = (path: string, flags: { releases: boolean; securityAudit: boolean }) =>
		navGroups(flags)
			.flatMap((group) => group.items)
			.filter((item) => isNavItemActive(path, item))
			.map((item) => item.title)

	test("pages without a row of their own highlight their parent row", () => {
		const off = { releases: false, securityAudit: false }
		expect(activeTitles("/anomalies", off)).toEqual(["Alerts"])
		expect(activeTitles("/security/findings", off)).toEqual(["Code Review"])
		expect(activeTitles("/releases", off)).toEqual(["Services"])
	})

	test("a flagged page with its own row highlights only that row", () => {
		const on = { releases: true, securityAudit: true }
		expect(activeTitles("/security", on)).toEqual(["Security"])
		expect(activeTitles("/releases", on)).toEqual(["Releases"])
	})
})
