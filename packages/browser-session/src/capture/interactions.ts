import { truncateText } from "../platform/text"
import { BLOCK_ATTRIBUTE, BLOCK_CLASS, isBlocked } from "../privacy-markers"
import { type Emit, safeEmit } from "./shared"

const MAX_TEXT = 120
/** Bounds the walk on a click that lands on `<body>` or a huge container. */
const MAX_NODES = 500
/** rrweb's default mask class: replay shows its text as `*`, so neither may this. */
const MASK_CLASS = "rr-mask"
/** Text that is code, markup or user input rather than a visible label. */
const SKIPPED_TAGS = new Set([
	"SCRIPT",
	"STYLE",
	"NOSCRIPT",
	"TEMPLATE",
	"INPUT",
	"TEXTAREA",
	"SELECT",
	"OPTION",
])

/**
 * Capture clicks and input events as session events. Listens in the capture
 * phase so it sees interactions even when the host app calls
 * `stopPropagation()`. Input *values* are never recorded; only the target
 * element. Click target text is omitted when `maskAllText` is set, and when the
 * target sits inside a blocked (`.rr-block` / `data-rr-block`) or masked
 * (`.rr-mask`) subtree; blocked descendants of the target are skipped.
 */
export function installInteractionCapture(emit: Emit, maskAllText: boolean): () => void {
	const onClick = (event: Event): void => {
		const target = event.target
		if (!(target instanceof Element)) return
		safeEmit(emit, {
			type: "click",
			targetSelector: selectorOf(target),
			targetText: maskAllText || isBlocked(target) || isMasked(target) ? undefined : textOf(target),
		})
	}

	const onInput = (event: Event): void => {
		const target = event.target
		if (!(target instanceof Element)) return
		// Never capture the value — only that an input on this element occurred.
		safeEmit(emit, { type: "input", targetSelector: selectorOf(target) })
	}

	document.addEventListener("click", onClick, true)
	document.addEventListener("input", onInput, true)

	return () => {
		document.removeEventListener("click", onClick, true)
		document.removeEventListener("input", onInput, true)
	}
}

/** A short, human-readable selector: tag + #id + .first-class. */
export function selectorOf(el: Element): string {
	const tag = el.tagName.toLowerCase()
	const id = el.id ? `#${el.id}` : ""
	const cls =
		typeof el.className === "string" && el.className.trim()
			? `.${el.className.trim().split(/\s+/)[0]}`
			: ""
	return `${tag}${id}${cls}`
}

/** An element whose text must not be read: blocked, masked, code, or editable. */
function isHiddenText(el: Element): boolean {
	return (
		SKIPPED_TAGS.has(el.tagName.toUpperCase()) ||
		el.classList.contains(BLOCK_CLASS) ||
		el.classList.contains(MASK_CLASS) ||
		el.hasAttribute(BLOCK_ATTRIBUTE) ||
		(el instanceof HTMLElement && el.isContentEditable)
	)
}

function isMasked(el: Element): boolean {
	for (let node: Element | null = el; node !== null; node = node.parentElement) {
		if (node.classList.contains(MASK_CLASS)) return true
	}
	return false
}

/**
 * The target's visible label: its text nodes in document order, skipping hidden
 * subtrees and stopping once the cap is reached. `textContent` would read the
 * whole subtree, blocked parts and all, on every click.
 */
export function textOf(el: Element): string | undefined {
	if (isHiddenText(el)) return undefined
	let text = ""
	let visited = 0
	const stack: Node[] = [el]
	while (stack.length > 0 && visited < MAX_NODES && text.length <= MAX_TEXT) {
		const node = stack.pop()
		visited++
		if (node instanceof Text) {
			text = `${text}${node.data}`.replace(/\s+/g, " ").trimStart()
			continue
		}
		if (node !== el && (!(node instanceof Element) || isHiddenText(node))) continue
		const children = node?.childNodes ?? []
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i]
			if (child) stack.push(child)
		}
	}
	text = text.trim()
	if (!text) return undefined
	return truncateText(text, MAX_TEXT, "…")
}
