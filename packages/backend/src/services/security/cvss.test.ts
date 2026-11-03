import { describe, expect, it } from "vitest"
import { cvss3BaseScore, severityOfScore } from "./cvss"

// Expected scores come from FIRST's CVSS 3.1 calculator.
describe("cvss3BaseScore", () => {
	it.each([
		["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8, "critical"],
		["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N", 6.1, "medium"],
		["CVSS:3.1/AV:L/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H", 6.2, "medium"],
		["CVSS:3.0/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H", 9.9, "critical"],
		["CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N", 5.9, "medium"],
		["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H", 7.5, "high"],
		["CVSS:3.1/AV:P/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N", 1.6, "low"],
		["CVSS:3.1/AV:P/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:N", 0, "low"],
	] as const)("%s scores %d (%s)", (vector, score, severity) => {
		const computed = cvss3BaseScore(vector)
		expect(computed).toBe(score)
		expect(computed === undefined ? undefined : severityOfScore(computed)).toBe(severity)
	})

	it.each([
		"CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N",
		"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/C:H/I:H/A:H",
		"CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
		"AV:N/AC:L/Au:N/C:P/I:P/A:P",
		"",
	])("rejects %j", (vector) => {
		expect(cvss3BaseScore(vector)).toBeUndefined()
	})
})
