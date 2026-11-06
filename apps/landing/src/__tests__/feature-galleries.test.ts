import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { SHOTS } from "../../scripts/screenshots/shots"
import { features } from "../lib/features"
import { Array as Arr } from "effect"

/**
 * A gallery shot is only real if the capture script knows how to take it and
 * the file it writes is checked in. Either half missing renders a broken image.
 */
const screenshotsDir = resolve(__dirname, "../../public/screenshots")
const shotIds = new Set(Arr.map(SHOTS, (shot) => shot.id))

describe("feature galleries", () => {
	const gallery = Arr.flatMap(features, (feature) =>
		Arr.map(feature.gallery, (shot) => ({ slug: feature.slug, id: shot.id })),
	)

	it.each(gallery)("$slug: $id is a capture in shots.ts", ({ id }) => {
		expect(shotIds.has(id)).toBe(true)
	})

	it.each(gallery)("$slug: $id is checked in", ({ id }) => {
		expect(existsSync(join(screenshotsDir, `${id}.webp`))).toBe(true)
	})
})
