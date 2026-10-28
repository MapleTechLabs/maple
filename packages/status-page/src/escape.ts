/** Escapes text for HTML element content and quoted attributes alike. */
export const escapeHtml = (value: string): string =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;")

/** XML 1.0 forbids most control characters even when escaped, so they are dropped. */
export const escapeXml = (value: string): string =>
	// oxlint-disable-next-line no-control-regex
	escapeHtml(value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, ""))

/** A customer URL usable as a link or image: only absolute http(s), never `javascript:`. */
export const safeUrl = (value: string | null, protocols: ReadonlyArray<string>): string | null => {
	if (value === null || !URL.canParse(value)) return null
	const url = new URL(value)
	return protocols.includes(url.protocol) ? url.toString() : null
}

/** Only plain hex colours reach the stylesheet. */
export const safeColor = (value: string | null): string | null =>
	value !== null && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(value) ? value : null
