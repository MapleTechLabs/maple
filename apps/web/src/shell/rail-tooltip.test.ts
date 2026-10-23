import { describe, expect, test } from "vitest"
import { navGroups } from "./nav"
import { RAIL_TIP_TITLES } from "./view"

// The collapsed rail's tooltip only opens on rows it lists; an org's flags decide which rows show.
const FLAG_SETS = [false, true].flatMap((releases) =>
	[false, true].map((securityAudit) => ({ releases, securityAudit })),
)

describe("collapsed rail tooltip", () => {
	test("every nav row any org can be shown has a tooltip", () => {
		const shown = FLAG_SETS.flatMap((flags) =>
			navGroups(flags).flatMap((group) => group.items.map((item) => item.title)),
		)
		expect(shown.filter((title) => !RAIL_TIP_TITLES.includes(title))).toEqual([])
	})
})
