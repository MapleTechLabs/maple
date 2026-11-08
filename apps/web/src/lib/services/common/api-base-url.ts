import { Option, Array as Arr, String as Str } from "effect"

const configuredApiBaseUrl = Option.map(
	Option.fromNullishOr(import.meta.env.VITE_API_BASE_URL),
	Str.trim,
).pipe(Option.getOrUndefined)

export const apiBaseUrl =
	configuredApiBaseUrl && configuredApiBaseUrl.length > 0
		? Str.replace(/\/$/, "")(configuredApiBaseUrl)
		: "http://127.0.0.1:3472"

const configuredApiPublicUrl = Option.map(
	Option.fromNullishOr(import.meta.env.VITE_API_PUBLIC_URL),
	Str.trim,
).pipe(Option.getOrUndefined)

/** The API's real URL, for what users copy. `apiBaseUrl` can be the same-origin proxy. */
export const apiPublicUrl =
	configuredApiPublicUrl && configuredApiPublicUrl.length > 0
		? Str.replace(/\/$/, "")(configuredApiPublicUrl)
		: apiBaseUrl

const originOf = Option.liftThrowable((url: string) => new URL(url).origin)

/** The origins the API answers on: its own, and the proxy's when `apiBaseUrl` is same-origin. */
export const apiOrigins: ReadonlyArray<string> = Arr.flatMap([apiBaseUrl, apiPublicUrl], (url) =>
	Option.toArray(originOf(url)),
)
