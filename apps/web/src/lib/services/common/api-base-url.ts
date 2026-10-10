const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()

export const apiBaseUrl =
	configuredApiBaseUrl && configuredApiBaseUrl.length > 0
		? configuredApiBaseUrl.replace(/\/$/, "")
		: "http://127.0.0.1:3472"

const configuredApiPublicUrl = import.meta.env.VITE_API_PUBLIC_URL?.trim()

/** The API's real URL, for what users copy. `apiBaseUrl` can be the same-origin proxy. */
export const apiPublicUrl =
	configuredApiPublicUrl && configuredApiPublicUrl.length > 0
		? configuredApiPublicUrl.replace(/\/$/, "")
		: apiBaseUrl
