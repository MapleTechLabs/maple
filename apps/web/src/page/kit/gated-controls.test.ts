import * as Policy from "@maple/domain/policy"
import type { MenuEntry } from "@maple/views/ui/menu-view"
import { describe, expect, test } from "vitest"
import { gatedEntries } from "./gated-controls"

const entries: ReadonlyArray<MenuEntry> = [
	{ _tag: "Item", value: "open", label: "Open rule" },
	{ _tag: "Separator" },
	{ _tag: "Item", value: "toggle", label: "Disable rule" },
]

const member = { grants: Policy.grantsOf(["org:member"]) }
const engineer = { grants: Policy.grantsOf(["org:engineer"]) }

describe("gatedEntries", () => {
	test("a viewer with the permission gets the menu as it was", () => {
		expect(gatedEntries(engineer, "alerts:manage", entries, ["open"])).toEqual(entries)
	})

	test("a viewer without it gets each changing item disabled with who can, and read-only items untouched", () => {
		const [open, separator, toggle] = gatedEntries(member, "alerts:manage", entries, ["open"])
		expect(open).toEqual(entries[0])
		expect(separator).toEqual(entries[1])
		expect(toggle).toMatchObject({
			isDisabled: true,
			tooltip: { content: ["Only org admins and engineers can manage alerts."] },
		})
	})
})
