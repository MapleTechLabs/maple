import { Array as Arr, Option, String as Str } from "effect"

/**
 * The ad click id a Google Ads link carries, kept in a first-party cookie the dashboard hands to
 * sign-up. Never set for visitors in the EEA, the UK or Switzerland (where we ask no consent), for
 * an unknown country, or when the browser sends Global Privacy Control.
 */
export const AD_CLICK_COOKIE = "maple_ad_click"
const CLICK_PARAMS = ["gclid", "gbraid", "wbraid"] as const
const MAX_AGE_SECONDS = 90 * 24 * 60 * 60
const CLICK_ID = /^[A-Za-z0-9_-]{1,256}$/

/** EU and EEA members (with their outermost regions), the UK and its dependencies, Switzerland. */
const NO_CAPTURE_COUNTRIES: ReadonlySet<string> = new Set([
	"AT",
	"BE",
	"BG",
	"HR",
	"CY",
	"CZ",
	"DK",
	"EE",
	"FI",
	"FR",
	"DE",
	"GR",
	"HU",
	"IE",
	"IT",
	"LV",
	"LT",
	"LU",
	"MT",
	"NL",
	"PL",
	"PT",
	"RO",
	"SK",
	"SI",
	"ES",
	"SE",
	"GF",
	"GP",
	"MQ",
	"RE",
	"YT",
	"MF",
	"AX",
	"IS",
	"LI",
	"NO",
	"GB",
	"GI",
	"IM",
	"JE",
	"GG",
	"CH",
])

/** Whether a visitor from `country` (ISO 3166 alpha-2, as Cloudflare reports it) may be tracked. */
export const mayCaptureIn = (country: string | undefined): boolean =>
	country !== undefined &&
	/^[A-Z]{2}$/.test(country) &&
	country !== "XX" &&
	!NO_CAPTURE_COUNTRIES.has(country)

/** `Domain=maple.dev` on maple.dev and its subdomains, so the dashboard can read it; host-only elsewhere. */
const domainAttribute = (hostname: string): string =>
	hostname === "maple.dev" || Str.endsWith(".maple.dev")(hostname) ? "; Domain=maple.dev" : ""

/** The `Set-Cookie` value for this page request, or `null` when there is nothing to keep. */
export const adClickCookie = (
	request: Request,
	country: string | undefined,
	nowMs: number,
): string | null => {
	if (request.method !== "GET" || request.headers.get("Sec-GPC") === "1" || !mayCaptureIn(country)) {
		return null
	}
	const url = new URL(request.url)
	const found = Arr.findFirst(CLICK_PARAMS, (param) => {
		const value = url.searchParams.get(param)
		return value !== null && CLICK_ID.test(value)
	})
	if (Option.isNone(found)) return null
	const id = url.searchParams.get(found.value) ?? ""
	const secure = url.protocol === "https:" ? "; Secure" : ""
	return `${AD_CLICK_COOKIE}=${found.value}.${id}.${nowMs}; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax${secure}${domainAttribute(url.hostname)}`
}

/** `response` with the ad click cookie added, when the request carried a click to keep. */
export const withAdClickCookie = (
	request: Request,
	response: Response,
	country: string | undefined,
	nowMs: number,
): Response => {
	// A redirect counts too: `/pricing` answers 308 to `/pricing/` before any page is served.
	const cookie = response.status < 400 ? adClickCookie(request, country, nowMs) : null
	if (cookie === null) return response
	const headers = new Headers(response.headers)
	headers.append("Set-Cookie", cookie)
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
