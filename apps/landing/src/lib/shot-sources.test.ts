import { describe, expect, it } from "vitest"
import { shotSourcesIn, withShotSourcesIn } from "./shot-sources"

const copies = {
	"/screenshots/hero.webp": { width: 2880, widths: [960, 1440] },
	"/screenshots/guides/steps.webp": { width: 1820, widths: [960, 1440] },
}
const shotSources = shotSourcesIn(copies)
const withShotSources = withShotSourcesIn(copies)

describe("shotSources", () => {
	it("lists every copy and the capture itself at its real width", () => {
		expect(shotSources("/screenshots/hero.webp")).toEqual({
			srcset: "/screenshots/w/960/hero.webp 960w, /screenshots/w/1440/hero.webp 1440w, /screenshots/hero.webp 2880w",
			sizes: "auto, 100vw",
		})
	})

	it("assumes a cropped window is drawn its zoom times wider", () => {
		expect(shotSources("/screenshots/hero.webp", 2.4).sizes).toBe("auto, 240vw")
	})

	it("leaves a capture with no copies to its one file", () => {
		expect(shotSources("/screenshots/tiny.webp")).toEqual({})
	})
})

describe("withShotSources", () => {
	it("adds copies to a bare capture and keeps its other attributes", () => {
		const html = `<p><img src="/screenshots/guides/steps.webp" data-zoomable alt="Steps, 4 of them" loading="lazy" /></p>`
		expect(withShotSources(html)).toBe(
			`<p><img src="/screenshots/guides/steps.webp" srcset="/screenshots/w/960/guides/steps.webp 960w, /screenshots/w/1440/guides/steps.webp 1440w, /screenshots/guides/steps.webp 1820w" sizes="auto, 100vw" data-zoomable alt="Steps, 4 of them" loading="lazy" /></p>`,
		)
	})

	it("finds the capture when src is not the first attribute", () => {
		const html = `<img class="shot" src="/screenshots/hero.webp" alt="">`
		expect(withShotSources(html)).toContain(
			`class="shot" src="/screenshots/hero.webp" srcset="/screenshots/w/960/hero.webp 960w`,
		)
	})

	it("leaves a plate that sizes its own srcset, images outside the captures, and look-alike attributes", () => {
		const html = [
			`<img src="/screenshots/hero.webp" srcset="/screenshots/w/960/hero.webp 960w" sizes="auto, 240vw">`,
			`<img src="/people/author.webp" alt="">`,
			`<img data-src="/screenshots/hero.webp" alt="">`,
			`<img src="/screenshots/tiny.webp" alt="">`,
		].join("")
		expect(withShotSources(html)).toBe(html)
	})

	it("rewrites every capture on a page", () => {
		const html = `<img src="/screenshots/hero.webp"><img src="/screenshots/guides/steps.webp">`
		expect(withShotSources(html).match(/srcset=/g)).toHaveLength(2)
	})
})
