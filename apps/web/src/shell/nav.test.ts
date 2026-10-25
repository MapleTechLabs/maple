import { describe, expect, test } from "vitest"
import { navGroups, navSourceCount, partitionSubItems } from "./nav"

const infrastructure = navGroups({ releases: false, securityAudit: false })
	.flatMap((group) => group.items)
	.find((item) => item.title === "Infrastructure")
const subItems = infrastructure?.subItems ?? []
const countFor = (surfaces: ReadonlyArray<"aws" | "railway" | "hosts"> | null) => {
	if (infrastructure === undefined) return undefined
	const present = surfaces === null ? null : new Set(surfaces)
	return navSourceCount(infrastructure, present, partitionSubItems(subItems, present, "/").shown)
}

describe("navSourceCount", () => {
	test("counts only the sources an org reports", () => {
		expect(countFor(["aws", "railway"])).toBe(2)
	})

	test("shows no count when nothing reports or presence is unknown", () => {
		expect(countFor([])).toBeUndefined()
		expect(countFor(null)).toBeUndefined()
	})
})
