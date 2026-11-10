import { Array as Arr, String as Str } from "effect"

/**
 * Frame and referrer policy for document responses, as one table for the two layers that
 * serve documents: the Worker sets it on the responses it builds (`handler.ts`), and the
 * assets layer on the ones it serves without the Worker (`_headers`, passed in `worker.ts`).
 *
 * The app is a single-page bundle, so every route is the same index.html and the path is
 * all either layer knows. That is enough for the split that matters:
 *
 *   - Everything except `/share/` refuses framing outright. The authed app has no reason to
 *     be in anyone's iframe.
 *   - `/share/` allows framing at the document level, because embedding a public chart is a
 *     feature. Which links may be framed is decided by the API (`embeddable` on the resolve
 *     response) and enforced by the page, the only layer that knows which token it holds.
 *
 * `Referrer-Policy: no-referrer` is share-specific and load-bearing: the token is in the
 * share URL, so without it every cross-origin request the page makes hands the token to a
 * third party in `Referer`.
 */
export type HeaderEntries = ReadonlyArray<readonly [name: string, value: string]>

const SHARE_PATH = "/share"

export const isShareDocument = (pathname: string): boolean =>
	pathname === SHARE_PATH || Str.startsWith(`${SHARE_PATH}/`)(pathname)

/** Every document: no plugins, no `<base>` retargeting relative URLs. Keep in step with nginx.conf. */
const BASE_CSP = "object-src 'none'; base-uri 'self'"

export const APP_DOCUMENT_HEADERS: HeaderEntries = [
	["X-Content-Type-Options", "nosniff"],
	["Referrer-Policy", "strict-origin-when-cross-origin"],
	["Content-Security-Policy", `${BASE_CSP}; frame-ancestors 'none'`],
	["X-Frame-Options", "DENY"],
]

export const SHARE_DOCUMENT_HEADERS: HeaderEntries = [
	["X-Content-Type-Options", "nosniff"],
	["Referrer-Policy", "no-referrer"],
	["Content-Security-Policy", BASE_CSP],
]

export const documentHeaders = (pathname: string): HeaderEntries =>
	isShareDocument(pathname) ? SHARE_DOCUMENT_HEADERS : APP_DOCUMENT_HEADERS

const carries = (entries: HeaderEntries, name: string, value: string): boolean =>
	Arr.some(entries, ([entryName, entryValue]) => entryName === name && entryValue === value)

const attach = ([name, value]: readonly [name: string, value: string]): string => `${name}: ${value}`

const block = (pattern: string, lines: ReadonlyArray<string>): string =>
	`${pattern}\n${Arr.join(
		Arr.map(lines, (line) => `  ${line}`),
		"\n",
	)}\n`

// A request inherits every rule it matches and a repeated header is appended, so the share
// rule detaches what `/*` set before attaching its own.
const shareOverride: ReadonlyArray<string> = [
	...Arr.map(
		Arr.filter(APP_DOCUMENT_HEADERS, ([name, value]) => !carries(SHARE_DOCUMENT_HEADERS, name, value)),
		([name]) => `! ${name}`,
	),
	...Arr.map(
		Arr.filter(SHARE_DOCUMENT_HEADERS, ([name, value]) => !carries(APP_DOCUMENT_HEADERS, name, value)),
		attach,
	),
]

/**
 * The assets layer's `_headers` rules. App routes are served there, not by the Worker (it is
 * placed in one region, a hop that cost about a second per cold load), so a header set only
 * in `handler.ts` never reaches them.
 */
export const ASSET_HEADER_RULES: string = Arr.join(
	[
		// Vite's content-hashed output never changes under a name.
		block("/assets/*", ["Cache-Control: public, max-age=31536000, immutable"]),
		// Clients poll this to learn a newer bundle is deployed; a cached copy reports the old one.
		block("/version.json", ["Cache-Control: no-store, must-revalidate"]),
		block("/*", Arr.map(APP_DOCUMENT_HEADERS, attach)),
		block(SHARE_PATH, shareOverride),
		block(`${SHARE_PATH}/*`, shareOverride),
	],
	"",
)
