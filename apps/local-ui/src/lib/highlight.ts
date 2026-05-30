import { highlight } from "sugar-high"

/** Syntax-highlight a JSON string to HTML for the detail drawers' Raw views. */
export function highlightJson(code: string): string {
	return highlight(code)
}
