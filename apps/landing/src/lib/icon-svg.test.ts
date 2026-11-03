import { describe, expect, it } from "vitest"
import { iconSvg } from "./icon-svg"
import { Array as Arr, String as Str } from "effect"

const rootAttributes = (svg: string): Map<string, string> => {
	const root = Str.slice(0, svg.indexOf(">"))(svg)
	return new Map(
		Arr.map([...root.matchAll(/ ([\w:-]+)="([^"]*)"/g)], (match) => [match[1] ?? "", match[2] ?? ""]),
	)
}

describe("iconSvg", () => {
	it("renders one svg with the requested size and class and no unresolved markers", () => {
		const svg = iconSvg("FileIcon", { size: 16, className: "h-4 w-4" })
		const root = rootAttributes(svg)
		expect(svg.match(/<svg[ >]/g)?.length).toBe(1)
		expect(Str.startsWith("<svg ")(svg)).toBe(true)
		expect(Str.endsWith("</svg>")(svg)).toBe(true)
		expect(root.get("width")).toBe("16")
		expect(root.get("height")).toBe("16")
		expect(root.get("class")).toBe("h-4 w-4")
		expect(svg).not.toMatch(/__icon_|7777/)
	})

	it("defaults to 24 and omits the class when none is given", () => {
		const root = rootAttributes(iconSvg("BellIcon"))
		expect(root.get("width")).toBe("24")
		expect(root.has("class")).toBe(false)
	})

	it("replaces a default attribute once and escapes attribute values", () => {
		const svg = iconSvg("MapleMark", {
			attributes: { "aria-hidden": "true", "aria-label": `a & "b" <c` },
		})
		const root = rootAttributes(svg)
		expect(root.get("role")).toBe("img")
		expect(root.get("aria-hidden")).toBe("true")
		expect(root.get("aria-label")).toBe("a &amp; &quot;b&quot; &lt;c")
		expect(Str.split("aria-label=")(svg).length).toBe(2)
	})

	it("gives an icon's gradient ids the icon's own prefix", () => {
		const svg = iconSvg("AzureIcon")
		expect(svg).toContain(`id="AzureIcon-a"`)
		expect(svg).toContain(`fill="url(#AzureIcon-a)"`)
		expect(svg).not.toMatch(/__icon_|7777/)
	})
})
