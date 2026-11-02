import { describe, expect, it } from "vitest"
import { iconSvg } from "./icon-svg"

const rootAttributes = (svg: string): Map<string, string> => {
	const root = svg.slice(0, svg.indexOf(">"))
	return new Map([...root.matchAll(/ ([\w:-]+)="([^"]*)"/g)].map((match) => [match[1] ?? "", match[2] ?? ""]))
}

describe("iconSvg", () => {
	it("renders one svg with the requested size and class and no unresolved markers", () => {
		const svg = iconSvg("FileIcon", { size: 16, className: "h-4 w-4" })
		const root = rootAttributes(svg)
		expect(svg.match(/<svg[ >]/g)?.length).toBe(1)
		expect(svg.startsWith("<svg ")).toBe(true)
		expect(svg.endsWith("</svg>")).toBe(true)
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
		const svg = iconSvg("MapleMark", { attributes: { "aria-hidden": "true", "aria-label": `a & "b" <c` } })
		const root = rootAttributes(svg)
		expect(root.get("role")).toBe("img")
		expect(root.get("aria-hidden")).toBe("true")
		expect(root.get("aria-label")).toBe("a &amp; &quot;b&quot; &lt;c")
		expect(svg.split("aria-label=").length).toBe(2)
	})

	it("gives an icon's gradient ids the icon's own prefix", () => {
		const svg = iconSvg("AzureIcon")
		expect(svg).toContain(`id="AzureIcon-a"`)
		expect(svg).toContain(`fill="url(#AzureIcon-a)"`)
		expect(svg).not.toMatch(/__icon_|7777/)
	})
})
