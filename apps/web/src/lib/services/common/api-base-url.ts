const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()

export const apiBaseUrl =
	configuredApiBaseUrl && configuredApiBaseUrl.length > 0
		? configuredApiBaseUrl.replace(/\/$/, "")
		: "http://127.0.0.1:3472"

const configuredApiPublicUrl = import.meta.env.VITE_API_PUBLIC_URL?.trim()

/**
 * The API's own public URL, for anything a user copies or another tool calls.
 * `apiBaseUrl` can be this app's same-origin proxy, which only the app should use.
 */
export const apiPublicUrl =
	configuredApiPublicUrl && configuredApiPublicUrl.length > 0
		? configuredApiPublicUrl.replace(/\/$/, "")
		: apiBaseUrl
