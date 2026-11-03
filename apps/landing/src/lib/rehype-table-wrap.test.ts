import { describe, expect, it } from "vitest"
import rehypeTableWrap from "./rehype-table-wrap.mjs"

interface Node {
	type: string
	tagName?: string
	value?: string
	properties?: Record<string, unknown>
	children?: Node[]
}

const h = (
	tagName: string,
	properties: Record<string, unknown>,
	children: Array<Node | string> = [],
): Node => ({
	type: "element",
	tagName,
	properties,
	children: children.map((child) => (typeof child === "string" ? { type: "text", value: child } : child)),
})

const run = (children: Node[], path = "/repo/apps/landing/src/content/docs/reference/cli.md") => {
	const tree: Node = { type: "root", children }
	rehypeTableWrap()(tree, { path })
	return tree
}

const find = (node: Node, test: (n: Node) => boolean): Node[] => [
	...(test(node) ? [node] : []),
	...(node.children ?? []).flatMap((child) => find(child, test)),
]

const classes = (node: Node) => {
	const names = node.properties?.className
	return Array.isArray(names) ? names : []
}

const textOf = (node: Node): string =>
	node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textOf).join("")

const table = (headers: string[], rows: Array<Array<Node | string>>) =>
	h("table", {}, [
		h("thead", {}, [
			h(
				"tr",
				{},
				headers.map((header) => h("th", {}, [header])),
			),
		]),
		h(
			"tbody",
			{},
			rows.map((row) =>
				h(
					"tr",
					{},
					row.map((cell) => h("td", {}, [cell])),
				),
			),
		),
	])

describe("rehypeTableWrap", () => {
	it("wraps every table in a scroll container", () => {
		const tree = run([table(["A", "B"], [["1", "2"]])], "/repo/apps/landing/src/content/blog/post.md")
		expect(tree.children?.[0]).toMatchObject({
			tagName: "div",
			properties: { className: ["table-wrap"] },
		})
	})

	it("leaves blog and changelog content otherwise untouched", () => {
		const tree = run(
			[
				h("p", {}, [h("code", {}, ["--checkpoint-interval"])]),
				table(["Flag", "Default", "Description"], [["--port", "4318", "x".repeat(60)]]),
			],
			"/repo/apps/landing/src/content/blog/post.md",
		)
		expect(find(tree, (n) => classes(n).some((c) => c === "nw" || c.startsWith("is-")))).toEqual([])
	})

	it("keeps short inline code on one line", () => {
		const tree = run([h("p", {}, [h("code", {}, ["--checkpoint-interval"])])])
		const [code] = find(tree, (n) => n.tagName === "code")
		expect(classes(code)).toContain("nw")
		expect(textOf(code)).toBe("--checkpoint-interval")
	})

	it("breaks long URLs only after a path slash, never inside the scheme", () => {
		const url = "https://ingest.eu.maple.dev/v1/traces/with/a/long/path"
		const tree = run([h("p", {}, [h("code", {}, [url])])])
		const [code] = find(tree, (n) => n.tagName === "code")
		const pieces = find(code, (n) => classes(n).includes("nw")).map(textOf)
		expect(pieces.join("")).toBe(url)
		expect(pieces[0]).toBe("https://ingest.eu.maple.dev/")
		expect(pieces.every((piece) => !piece.endsWith(":/"))).toBe(true)
	})

	it("marks the prose column and short cells", () => {
		const tree = run([
			table(
				["Flag", "Default", "Description"],
				[["--port", "4318", "Port for OTLP ingest, the query API and the bundled UI"]],
			),
		])
		const headers = find(tree, (n) => n.tagName === "th")
		expect(headers.map((th) => classes(th).includes("is-prose"))).toEqual([false, false, true])
		const cells = find(tree, (n) => n.tagName === "td")
		expect(cells.map((td) => classes(td).includes("is-short"))).toEqual([true, true, false])
	})

	it("gives tables with the same header row one shared set of column widths", () => {
		const tree = run([
			table(["Tool", "Access", "What it does"], [["list_services", "read", "Lists services"]]),
			table(
				["Tool", "Access", "What it does"],
				[["get_instrumentation_recommendations", "read", "Suggests what to instrument next"]],
			),
		])
		const widths = find(tree, (n) => n.tagName === "colgroup").map((group) =>
			(group.children ?? []).map((col) => col.properties?.style),
		)
		expect(widths).toHaveLength(2)
		expect(widths[0]).toEqual(widths[1])
	})

	it("folds a prompt fence into word spans, keeping a short flag with its word and the text unchanged", () => {
		const prompt = "Run npx skills add https://github.com/Makisuo/maple --skill maple-agent-tracing -y"
		const tree = run([h("pre", { dataLanguage: "text", class: "astro-code" }, [h("code", {}, [prompt])])])
		const [pre] = find(tree, (n) => n.tagName === "pre")
		expect(classes(pre)).toEqual(expect.arrayContaining(["astro-code", "is-folded"]))
		expect(textOf(pre)).toBe(prompt)
		const words = find(pre, (n) => classes(n).includes("tok")).map(textOf)
		expect(words.at(-1)).toBe("maple-agent-tracing -y")
	})

	it("leaves laid-out text fences such as file trees alone", () => {
		const tree = run([
			h("pre", { dataLanguage: "text" }, [h("code", {}, ["data/\n  checkpoints/\n  quarantine/"])]),
		])
		const [pre] = find(tree, (n) => n.tagName === "pre")
		expect(classes(pre)).not.toContain("is-folded")
	})
})
