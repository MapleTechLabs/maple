import { Array as Arr, Option, String as Str } from "effect"

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

const URL_TEMPLATE_PARTS = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)?([^/?#]*)([^?#]*)(\?[^#]*)?/u

/**
 * A URL, or a `{{name}}` URL template, with what may be a credential replaced: the userinfo and
 * the fragment go, and every query value becomes `marker`. Read as text, so a template survives.
 */
export const redactUrlCredentials = (raw: string, marker: string): string => {
	const [, scheme = "", authority = "", path = "", query] = URL_TEMPLATE_PARTS.exec(Str.trim(raw)) ?? []
	const host = Option.match(Str.lastIndexOf("@")(authority), {
		onNone: () => authority,
		onSome: (at) => Str.slice(at + 1)(authority),
	})
	if (query === undefined) return `${scheme}${host}${path}`
	const pairs = Arr.map(
		Arr.filter(Str.split(Str.slice(1)(query), "&"), (pair) => pair !== ""),
		// A pair with no `=` may itself be the token, so it is not kept as a name.
		(pair) =>
			Option.match(Str.indexOf("=")(pair), {
				onNone: () => marker,
				onSome: (equals) => `${Str.slice(0, equals)(pair)}=${marker}`,
			}),
	)
	return `${scheme}${host}${path}${pairs.length === 0 ? "" : `?${Arr.join(pairs, "&")}`}`
}

/**
 * Whether a URL (or URL template) carries `marker` where {@link redactUrlCredentials} writes it:
 * as a query value, plain or percent-encoded. Such a URL was read back from a redacted response,
 * and saving it would replace the real value with the marker.
 */
export const urlHoldsRedaction = (raw: string, marker: string): boolean => {
	const [, , , , query] = URL_TEMPLATE_PARTS.exec(Str.trim(raw)) ?? []
	if (query === undefined) return false
	const markers = [marker, encodeURIComponent(marker)]
	return Arr.some(
		Str.split(Str.slice(1)(query), "&"),
		(pair) =>
			Arr.contains(markers, pair) ||
			Option.match(Str.indexOf("=")(pair), {
				onNone: () => false,
				onSome: (equals) => Arr.contains(markers, Str.slice(equals + 1)(pair)),
			}),
	)
}
