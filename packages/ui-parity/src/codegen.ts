import { readFileSync } from "node:fs"
import { parseFragment, type DefaultTreeAdapterMap } from "parse5"

/**
 * Translates reference markup (a capture's `<variant>.html`) into Foldkit view code.
 *
 * The output keeps every class string, data-/aria- attribute and SVG path verbatim,
 * which is what makes pixel parity mostly automatic. A human or agent then replaces
 * literals with Model data, maps lists, and wires events.
 *
 * - `class` → `h.Class`, `style` → `h.Style`, everything else → `h.Attribute`
 * - React and Base UI bookkeeping (generated `useId` / `base-ui-*` ids) is dropped
 * - class strings used more than once are hoisted into named constants
 */

type Node = DefaultTreeAdapterMap["childNode"]
type Element = DefaultTreeAdapterMap["element"]

const DROPPED_ATTRIBUTES = new Set<string>([])
const isGeneratedId = (name: string, value: string) => name === "id" && /^base-ui-|^_r_|«r|^:r/.test(value)

const SVG_CASE: Record<string, string> = {
	clippath: "clipPath",
	lineargradient: "linearGradient",
	radialgradient: "radialGradient",
	foreignobject: "foreignObject",
}

const quote = (value: string) => JSON.stringify(value)

const parseStyle = (style: string) =>
	Object.fromEntries(
		style
			.split(";")
			.map((declaration) => declaration.trim())
			.filter(Boolean)
			.map((declaration) => {
				const index = declaration.indexOf(":")
				return [declaration.slice(0, index).trim(), declaration.slice(index + 1).trim()]
			}),
	)

const renderNode = (node: Node, depth: number, hoisted: ReadonlyMap<string, string>): string | undefined => {
	const indent = "\t".repeat(depth)
	if (node.nodeName === "#text") {
		const text = (node as DefaultTreeAdapterMap["textNode"]).value.replace(/\s+/g, " ").trim()
		return text ? `${indent}${quote(text)}` : undefined
	}
	if (!("tagName" in node)) return undefined
	const element = node as Element
	const tag = SVG_CASE[element.tagName] ?? element.tagName
	const attributes = element.attrs
		.filter((attr) => !DROPPED_ATTRIBUTES.has(attr.name) && !isGeneratedId(attr.name, attr.value))
		.map((attr) => {
			if (attr.name === "class") return `h.Class(${hoisted.get(attr.value) ?? quote(attr.value)})`
			if (attr.name === "style") return `h.Style(${JSON.stringify(parseStyle(attr.value))})`
			return `h.Attribute(${quote(attr.name)}, ${quote(attr.value)})`
		})
	const children = (element.childNodes as Node[])
		.map((child) => renderNode(child, depth + 1, hoisted))
		.filter((child): child is string => child !== undefined)
	const attrs = attributes.length ? `[${attributes.join(", ")}]` : "[]"
	if (!children.length) return `${indent}h.${tag}(${attrs}, [])`
	return `${indent}h.${tag}(\n${indent}\t${attrs},\n${indent}\t[\n${children.join(",\n")},\n${indent}\t],\n${indent})`
}

export interface CodegenOptions {
	/** 1-based line in the source file where the element to translate starts. */
	readonly line?: number
	/** Name of the generated function. */
	readonly name?: string
}

export const htmlToFoldkit = (html: string, options: CodegenOptions = {}) => {
	const fragment = parseFragment(html, { sourceCodeLocationInfo: true })
	const elements = (nodes: ReadonlyArray<Node>): Element[] =>
		nodes.flatMap((node) =>
			"tagName" in node ? [node as Element, ...elements(node.childNodes as Node[])] : [],
		)
	const all = elements(fragment.childNodes as Node[])
	const root = options.line
		? all.find((element) => element.sourceCodeLocation?.startLine === options.line)
		: all[0]
	if (!root) throw new Error(`codegen: no element starts on line ${options.line}`)

	const classCounts = new Map<string, number>()
	for (const element of elements([root])) {
		const cls = element.attrs.find((attr) => attr.name === "class")?.value
		if (cls) classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1)
	}
	const hoisted = new Map<string, string>()
	for (const [cls, count] of classCounts) {
		if (count > 1 && cls.length > 40) hoisted.set(cls, `className${hoisted.size + 1}`)
	}

	const constants = [...hoisted].map(([cls, name]) => `const ${name} = ${quote(cls)}`).join("\n")
	const body = renderNode(root, 1, hoisted)
	return `${constants ? `${constants}\n\n` : ""}export const ${options.name ?? "view"} = <Message>(h: HtmlBuilder<Message>): Html =>\n${body?.trimStart()}\n`
}

/** Translates every child of the first element (e.g. an `<svg>`'s contents) into Foldkit expressions. */
export const htmlChildrenToFoldkit = (
	html: string,
	depth = 1,
): {
	readonly rootAttributes: ReadonlyArray<{ name: string; value: string }>
	readonly children: ReadonlyArray<string>
} => {
	const fragment = parseFragment(html)
	const root = fragment.childNodes.find((node) => "tagName" in node) as Element | undefined
	if (!root) throw new Error("codegen: no root element")
	const children = (root.childNodes as Node[])
		.map((child) => renderNode(child, depth, new Map()))
		.filter((child): child is string => child !== undefined)
	return { rootAttributes: root.attrs, children }
}

export const codegenFile = (path: string, options: CodegenOptions) =>
	htmlToFoldkit(readFileSync(path, "utf8"), options)
