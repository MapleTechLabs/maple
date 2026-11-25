import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { serviceTabs, tabOf } from "./derive"

const values = (context: Parameters<typeof serviceTabs>[0]) =>
	Arr.map(serviceTabs(context), (tab) => tab.value)

describe("service page tabs", () => {
	test("Profiles shows only inside the profiling rollout", () => {
		expect(values({})).toEqual(["overview", "api", "operations", "dependencies"])
		expect(values({ hasProfiling: true })).toContain("profiles")
	})

	// The other tabs read rollups that only name a service, which the API refuses a limited role.
	test("a role limited to namespaces gets Overview alone, whatever the link asks for", () => {
		expect(values({ audience: "scoped", hasProfiling: true })).toEqual(["overview"])
		expect(tabOf({ tab: "dependencies" }, { audience: "scoped" })).toBe("overview")
		expect(tabOf({ tab: "dependencies" }, { audience: "operator" })).toBe("dependencies")
	})
})
