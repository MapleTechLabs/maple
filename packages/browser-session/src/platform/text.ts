/**
 * Cut `text` to at most `max` UTF-16 units without splitting a surrogate pair,
 * appending `suffix` when anything was cut. Half an emoji is a lone surrogate,
 * which strict JSON parsers reject along with the batch carrying it.
 */
export function truncateText(text: string, max: number, suffix = ""): string {
	if (text.length <= max) return text
	let end = Math.max(0, max)
	const last = text.charCodeAt(end - 1)
	if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--
	return `${text.slice(0, end)}${suffix}`
}
