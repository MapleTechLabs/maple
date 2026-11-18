import { MARKS_PERSONAL_DATA_BY_KIND } from "@maple/domain/data-sources"
import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { DATA_SOURCE_DRIVERS } from "./drivers"

describe("the drivers this deployment serves", () => {
	it("each say of their own catalog what the connect form is told about their kind", () => {
		// The form has no source to ask before the first one is saved, so it reads the kind's entry.
		expect(Arr.map(DATA_SOURCE_DRIVERS, (driver) => [driver.kind, driver.marksPersonalData])).toEqual(
			Arr.map(DATA_SOURCE_DRIVERS, (driver) => [driver.kind, MARKS_PERSONAL_DATA_BY_KIND[driver.kind]]),
		)
	})
})
