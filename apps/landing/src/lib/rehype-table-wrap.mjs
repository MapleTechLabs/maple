// Wraps every markdown table in a scroll container. Reference pages carry
// four-column flag tables that are wider than a phone; without the wrapper
// they widen the whole page and the fixed header gets cut off.
//
// On docs pages it also decides where code may wrap, since CSS alone breaks
// flags at their hyphens: inline code up to 30 characters gets `nw` (one
// line), longer code is split into nowrap pieces at its separators, text
// fences get one nowrap span per word, and table cells and headers get
// sizing classes the docs CSS reads.
const SHORT_CODE = 30
const SHORT_CELL = 12
const SHORT_HEADER_WORDS = 3

const el = (tagName, className, children = []) => ({
	type: "element",
	tagName,
	properties: className ? { className: [className] } : {},
	children,
})
const text = (value) => ({ type: "text", value })
// Shiki's <pre> carries a `class` string rather than hast's `className` list.
const addClass = (node, name) => {
	const { class: raw, className = [], ...rest } = node.properties ?? {}
	const names = [
		...(raw ? String(raw).split(" ") : []),
		...(Array.isArray(className) ? className : [className]),
	]
	node.properties = { ...rest, className: [...names, name] }
}

const textOf = (node) =>
	node.type === "text" ? node.value : Array.isArray(node.children) ? node.children.map(textOf).join("") : ""

const elementsOf = (node, tagName) =>
	(node.children ?? []).flatMap((child) =>
		child.type !== "element" ? [] : child.tagName === tagName ? [child] : elementsOf(child, tagName),
	)

// Code longer than SHORT_CODE folds at its spaces and at separators: URLs
// after a path `/` or `=` (never inside `https://`), types after `|`, `<`, `,`,
// long names after `.`, other long code after `- _ . / | < , (`. Each piece
// between break points is nowrap, so nothing folds at a hyphen by accident.
const URL_BREAK = /(?<=[^/:]\/|=)(?=[^/])/
const TYPE_BREAK = /(?<=[|<,])(?=\S)/
const NAME_BREAK = /(?<=\.)(?=\S)/
const LONG_BREAK = /(?<=[-_./|<,(])(?=\S)/

const pieces = (value, breakAt) =>
	value
		.split(/(\s+)/)
		.filter(Boolean)
		.flatMap((word) =>
			/^\s+$/.test(word)
				? [text(word)]
				: word
						.split(breakAt)
						.flatMap((part, i) => [...(i ? [el("wbr")] : []), el("span", "nw", [text(part)])]),
		)

// `cell` is "name" for a table's first column, "value" for its other cells
// (types wrap at their separators), undefined in prose.
const breakInlineCode = (code, cell) => {
	if (!code.children.every((child) => child.type === "text")) return
	const value = textOf(code)
	const breakAt = value.includes("://")
		? URL_BREAK
		: cell === "value" && value.length <= SHORT_CODE
			? TYPE_BREAK
			: cell === "name"
				? NAME_BREAK
				: LONG_BREAK
	if (value.length <= SHORT_CODE && (cell !== "value" || !/[\s|<,]/.test(value))) addClass(code, "nw")
	else code.children = pieces(value, breakAt)
}

// Prompt fences fold, one nowrap span per word, so they wrap only at
// whitespace; a flag of one or two characters (`-y`) stays with the word before
// it, and URLs may still break after a `/`. Fences with aligned columns or
// indentation (file trees) are left to scroll. The copied text is unchanged.
const TEXT_LANGS = new Set(["text", "plaintext", "txt"])

const isLaidOut = (value) => value.split("\n").some((line) => /^\s+\S|\S {2,}\S/.test(line))

const word = (value) => el("span", "tok", value.includes("://") ? pieces(value, URL_BREAK) : [text(value)])

const words = (value) =>
	value
		.split(/(\s+)/)
		.filter(Boolean)
		.reduce((out, part) => {
			const space = out.at(-1)?.type === "text" ? out.at(-1) : undefined
			const before = space ? out.at(-2) : undefined
			if (/^\s+$/.test(part)) return [...out, text(part)]
			if (part.length <= 2 && before?.properties?.className?.includes("tok") && space.value === " ") {
				return [...out.slice(0, -2), word(`${textOf(before)} ${part}`)]
			}
			return [...out, word(part)]
		}, [])

const foldPromptFence = (node) => {
	if (!Array.isArray(node.children)) return
	node.children = node.children.flatMap((child) => {
		if (child.type !== "text") {
			foldPromptFence(child)
			return [child]
		}
		return words(child.value)
	})
}

const markCells = (table) => {
	for (const th of elementsOf(table, "th")) {
		if (textOf(th).trim().split(/\s+/).length > SHORT_HEADER_WORDS) addClass(th, "is-wrap")
	}
	for (const td of elementsOf(table, "td")) {
		if (textOf(td).trim().length <= SHORT_CELL) addClass(td, "is-short")
	}
}

// The column of running prose (a "Description") gets `is-prose` on its header,
// so the CSS gives it the larger share and the short columns size to content.
const markProseColumn = (table) => {
	const rows = elementsOf(table, "tr")
	const headers = rows.length ? elementsOf(rows[0], "th") : []
	const lengths = headers.map((_, i) => {
		const cells = rows.map((row) => elementsOf(row, "td")[i]).filter(Boolean)
		return cells.length ? cells.reduce((sum, cell) => sum + textOf(cell).length, 0) / cells.length : 0
	})
	const widest = lengths.indexOf(Math.max(...lengths))
	if (headers.length > 2 && lengths[widest] > 40) addClass(headers[widest], "is-prose")
}

// Tables in one page that share a header row (the MCP tool lists) get the same
// column widths, so their columns line up down the page. The layout stays auto,
// so a column still grows to fit a token that cannot wrap.
const signatureOf = (table) =>
	elementsOf(table, "th")
		.map((th) => textOf(th).trim())
		.join("|")

const alignRepeatedTables = (tables) => {
	const groups = Map.groupBy(tables, signatureOf)
	for (const group of groups.values()) {
		if (group.length < 2) continue
		const columns = elementsOf(group[0], "th").length
		const cellText = (row, i) => textOf(row.children.filter((c) => c.type === "element")[i] ?? text(""))
		const longest = Array.from({ length: columns }, (_, i) =>
			Math.max(
				8,
				...group.flatMap((table) =>
					elementsOf(table, "tr").map((row) => Math.min(60, cellText(row, i).length)),
				),
			),
		)
		const total = longest.reduce((sum, n) => sum + n, 0)
		for (const table of group) {
			table.children.unshift(
				el(
					"colgroup",
					undefined,
					longest.map((n) => ({
						...el("col"),
						properties: { style: `width:${((n / total) * 100).toFixed(1)}%` },
					})),
				),
			)
		}
	}
}

const markDocsCode = (node, tables, cell) => {
	if (!Array.isArray(node.children)) return
	const cells = node.children.filter((child) => child.type === "element" && child.tagName === "td")
	for (const child of node.children) {
		if (child.type !== "element") continue
		if (child.tagName === "pre") {
			const lang = child.properties?.dataLanguage ?? child.properties?.["data-language"]
			if (TEXT_LANGS.has(String(lang)) && !isLaidOut(textOf(child))) {
				addClass(child, "is-folded")
				foldPromptFence(child)
			}
			continue
		}
		if (child.tagName === "code") {
			breakInlineCode(child, cell)
			continue
		}
		if (child.tagName === "table") tables.push(child)
		const childCell = child.tagName === "td" ? (cells[0] === child ? "name" : "value") : cell
		markDocsCode(child, tables, childCell)
	}
}

const wrapTables = (node) => {
	if (!Array.isArray(node.children)) return
	node.children = node.children.map((child) => {
		if (child.type === "element" && child.tagName === "table") return el("div", "table-wrap", [child])
		wrapTables(child)
		return child
	})
}

// Blog and changelog markdown keep the bare wrapper; the rest is docs-only.
export default function rehypeTableWrap() {
	return (tree, file) => {
		if ((file?.path ?? "").includes("/content/docs/")) {
			const tables = []
			markDocsCode(tree, tables)
			for (const table of tables) {
				markCells(table)
				markProseColumn(table)
			}
			alignRepeatedTables(tables)
		}
		wrapTables(tree)
	}
}
