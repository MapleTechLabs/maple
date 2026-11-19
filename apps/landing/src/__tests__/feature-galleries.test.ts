import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { STATUS_PAGE_SHOTS } from "../../scripts/screenshots/status-page-shots"
import { SHOTS } from "../../scripts/screenshots/shots"
import { features } from "../lib/features"
import { Array as Arr } from "effect"

/**
 * A gallery or hero shot is only real if the capture script knows how to take it and
 * the file it writes is checked in. Either half missing renders a broken image.
 */
const publicDir = resolve(__dirname, "../../public")
const screenshotsDir = join(publicDir, "screenshots")
const shotIds = new Set(Arr.map([...SHOTS, ...STATUS_PAGE_SHOTS], (shot) => shot.id))

describe("feature galleries", () => {
	const gallery = Arr.flatMap(features, (feature) =>
		Arr.map(feature.heroShot ? [feature.heroShot, ...feature.gallery] : feature.gallery, (shot) => ({
			slug: feature.slug,
			id: shot.id,
		})),
	)
	const plates = Arr.flatMap(features, (feature) =>
		feature.panel?.plate.src ? [{ slug: feature.slug, src: feature.panel.plate.src }] : [],
	)

	it.each(gallery)("$slug: $id is a known capture", ({ id }) => {
		expect(shotIds.has(id)).toBe(true)
	})

	it.each(gallery)("$slug: $id is checked in", ({ id }) => {
		expect(existsSync(join(screenshotsDir, `${id}.webp`))).toBe(true)
	})

	it.each(plates)("$slug: the panel plate $src is checked in", ({ src }) => {
		expect(existsSync(join(publicDir, src))).toBe(true)
	})
})
