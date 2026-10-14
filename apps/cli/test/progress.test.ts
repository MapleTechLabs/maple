import { describe, it } from "@effect/vitest"
import { ok, strictEqual } from "node:assert"
import { fitLine } from "../src/lib/progress"

const suffixes = ["  ██████░░░░  60%  6.0 MB / 10.0 MB  2.0 MB/s", "  ██████░░░░  60%", "  60%", ""]

describe("fitLine", () => {
	it("keeps the richest suffix when the terminal is wide", () => {
		strictEqual(
			fitLine("  ⠋ ", "Downloading bundle", suffixes, 120),
			`  ⠋ Downloading bundle${suffixes[0]}`,
		)
	})

	it("drops detail until the line fits", () => {
		strictEqual(
			fitLine("  ⠋ ", "Downloading bundle", suffixes, 45),
			`  ⠋ Downloading bundle${suffixes[1]}`,
		)
	})

	it("never reaches the terminal width, so the redraw cannot wrap", () => {
		for (const columns of [8, 12, 20, 30, 40, 60, 80]) {
			const line = fitLine("  ⠋ ", "Downloading bundle", suffixes, columns)
			ok(Bun.stringWidth(line) < columns, `${columns} columns: ${JSON.stringify(line)}`)
		}
	})
})
