import { describe, it } from "@effect/vitest"
import { strict as assert } from "node:assert"
import { parseChangelog, releasesBetween } from "../src/core/changelog"

const markdown = `# @maple/cli

## 0.0.26

### Patch Changes

- Third

## 0.0.25

### Minor Changes

- Second

## 0.0.24

### Patch Changes

- First
`

describe("changelog", () => {
	const releases = parseChangelog(markdown)

	it("splits the changesets file into one entry per version, newest first", () => {
		assert.deepEqual(
			releases.map((r) => r.version),
			["0.0.26", "0.0.25", "0.0.24"],
		)
		assert.equal(releases[1]?.notes, "### Minor Changes\n\n- Second")
	})

	it("lists the releases after --since up to the installed version", () => {
		assert.deepEqual(
			releasesBetween(releases, "0.0.24", "0.0.25").map((r) => r.version),
			["0.0.25"],
		)
		assert.deepEqual(
			releasesBetween(releases, "v0.0.23", "v0.0.26").map((r) => r.version),
			["0.0.26", "0.0.25", "0.0.24"],
		)
	})

	it("gives a dev build everything after --since", () => {
		assert.deepEqual(
			releasesBetween(releases, "0.0.25", "dev").map((r) => r.version),
			["0.0.26"],
		)
	})
})
