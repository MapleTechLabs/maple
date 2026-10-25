/**
 * A URL with its userinfo, query string and fragment removed: scheme, host and path only. Scrape
 * and webhook URLs routinely carry tokens in those parts, so this is the form a URL takes in audit
 * rows and anything shown to a model.
 */
export const redactUrlSecrets = (raw: string): string => {
	if (!URL.canParse(raw)) return "<invalid-url>"
	const url = new URL(raw)
	return `${url.protocol}//${url.host}${url.pathname}`
}
