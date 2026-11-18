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

/** A percent-encoded query part decoded; none when its encoding is malformed. */
const decodeUrlPart = Option.liftThrowable(decodeURIComponent)

/**
 * Whether a URL (or URL template) carries `marker` where {@link redactUrlCredentials} writes it:
 * as a query value, plain or percent-encoded. Such a URL was read back from a redacted response,
 * and saving it would replace the real value with the marker.
 */
export const urlHoldsRedaction = (raw: string, marker: string): boolean => {
	const [, , , , query] = URL_TEMPLATE_PARTS.exec(Str.trim(raw)) ?? []
	if (query === undefined) return false
	// Compared decoded and without case: `%5bredacted%5d` is the marker as much as `%5Bredacted%5D`.
	const isMarker = (value: string) =>
		Str.toLowerCase(Option.getOrElse(decodeUrlPart(value), () => value)) === Str.toLowerCase(marker)
	return Arr.some(Str.split(Str.slice(1)(query), "&"), (pair) =>
		Option.match(Str.indexOf("=")(pair), {
			onNone: () => isMarker(pair),
			onSome: (equals) => isMarker(Str.slice(equals + 1)(pair)),
		}),
	)
}

/** One http(s) URL and nothing else: no whitespace, so free text that starts with a URL is not one. */
const WHOLE_HTTP_URL = /^https?:\/\/\S+$/iu

/**
 * `text` cut to scheme, host and path ({@link redactUrlSecrets}) when it is an http(s) URL with
 * userinfo, a query or a fragment. Only a string that is a URL as a whole (surrounding whitespace
 * aside) is handled: a URL inside other text is left alone, with the text.
 */
export const redactWholeUrlSecrets = (text: string): string => {
	const url = Str.trim(text)
	if (!WHOLE_HTTP_URL.test(url)) return text
	// One that does not parse cannot be cut, so it is judged by its text and none of it is kept.
	if (!URL.canParse(url)) return /[?#@]/u.test(url) ? redactUrlSecrets(url) : text
	const parsed = new URL(url)
	return parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === ""
		? text
		: redactUrlSecrets(url)
}
