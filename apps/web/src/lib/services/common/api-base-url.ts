import { Option, Array as Arr } from "effect"
import { envUrl } from "./env-url"

export const apiBaseUrl = envUrl(import.meta.env.VITE_API_BASE_URL) ?? "http://127.0.0.1:3472"

/** The API's real URL, for what users copy. `apiBaseUrl` can be the same-origin proxy. */
export const apiPublicUrl = envUrl(import.meta.env.VITE_API_PUBLIC_URL) ?? apiBaseUrl

const originOf = Option.liftThrowable((url: string) => new URL(url).origin)

/** The origins the API answers on: its own, and the proxy's when `apiBaseUrl` is same-origin. */
export const apiOrigins: ReadonlyArray<string> = Arr.flatMap([apiBaseUrl, apiPublicUrl], (url) =>
	Option.toArray(originOf(url)),
)
