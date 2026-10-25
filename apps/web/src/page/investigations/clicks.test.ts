import { describe, expect, test } from "vitest"
import { type ClickFacts, nodeLinkClick, rowClickId } from "./clicks"

// A target whose ancestors are the given selectors, each with its attributes.
const inside = (ancestors: Readonly<Record<string, Readonly<Record<string, string>>>>): ClickFacts["target"] => ({
	closest: (selector) => {
		const attributes = ancestors[selector]
		return attributes === undefined ? null : { getAttribute: (name) => attributes[name] ?? null }
	},
})

const click = (target: ClickFacts["target"], overrides: Partial<ClickFacts> = {}): ClickFacts => ({
	button: 0,
	metaKey: false,
	ctrlKey: false,
	shiftKey: false,
	altKey: false,
	defaultPrevented: false,
	target,
	...overrides,
})

const ROW = { "li[data-investigation-row]": { "data-investigation-row": "inv-1" } }

describe("investigation row clicks", () => {
	test("a click on the row's body opens it", () => {
		expect(rowClickId(click(inside(ROW)))).toBe("inv-1")
	})

	test("a click on the headline link is left to the link, so history gets one entry", () => {
		expect(rowClickId(click(inside({ ...ROW, a: { href: "/investigations/inv-1" } })))).toBeNull()
		expect(rowClickId(click(inside({ ...ROW, a: { href: "/investigations/inv-1" } }), { metaKey: true }))).toBeNull()
	})

	test("a click something else already handled opens nothing", () => {
		expect(rowClickId(click(inside(ROW), { defaultPrevented: true }))).toBeNull()
	})
})

describe("canvas node link clicks", () => {
	const link = inside({ "a[data-node-link]": { href: "/traces/abc" } })

	test("a plain click routes in place", () => {
		expect(nodeLinkClick(click(link))).toEqual({ href: "/traces/abc", isPlain: true })
	})

	test("a modified or middle click keeps the browser's new tab", () => {
		expect(nodeLinkClick(click(link, { metaKey: true }))?.isPlain).toBe(false)
		expect(nodeLinkClick(click(link, { ctrlKey: true }))?.isPlain).toBe(false)
		expect(nodeLinkClick(click(link, { button: 1 }))?.isPlain).toBe(false)
	})

	test("a click off any link is the card's", () => {
		expect(nodeLinkClick(click(inside({})))).toBeNull()
	})
})
