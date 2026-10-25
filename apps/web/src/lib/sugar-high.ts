import { highlight } from "sugar-high"
import { memoizeByText } from "./display-text"

/** Past this many characters code is shown plain: one text node instead of a span per token. */
export const HIGHLIGHT_MAX_CHARS = 50_000

const escapeHtml = (text: string): string =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Highlighted HTML for `code`, or escaped plain text when it is too long to highlight. */
export const highlightCode: (code: string) => string = memoizeByText((code) =>
	code.length > HIGHLIGHT_MAX_CHARS ? escapeHtml(code) : highlight(code),
)
