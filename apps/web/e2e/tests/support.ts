import type { Browser } from "@e2e-dev/web"

declare global {
	interface Window {
		Clerk?: { session?: { getToken: () => Promise<string> } | null }
	}
}

/** The preview's API origin: `app-pr-<n>` serves its API at `api-pr-<n>`. */
export const apiUrl = (appUrl: string): string =>
	process.env.MAPLE_E2E_API_URL ?? appUrl.replace("://app-", "://api-")

/**
 * A v2 API call made from the page, so it carries the signed-in Clerk session. The body
 * crosses back as JSON text: `evaluate` only returns JSON values.
 */
export const api = async <T>(
	browser: Browser,
	appUrl: string,
	path: string,
	init: { method?: string; body?: object } = {},
): Promise<{ status: number; body: T }> => {
	const result = await browser.evaluate(
		async ({ url, method, body }) => {
			// Clerk attaches its session a moment after the app shell renders.
			const session = async (deadline: number): Promise<{ getToken: () => Promise<string> }> => {
				const current = window.Clerk?.session
				if (current) return current
				if (Date.now() > deadline) throw new Error("No Clerk session on the page")
				await new Promise((resolve) => setTimeout(resolve, 200))
				return session(deadline)
			}
			const token = await (await session(Date.now() + 20_000)).getToken()
			const request: RequestInit = {
				method,
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			}
			if (body !== null) request.body = body
			const response = await fetch(url, request)
			return { status: response.status, text: await response.text() }
		},
		{
			url: `${apiUrl(appUrl)}${path}`,
			method: init.method ?? "GET",
			body: init.body === undefined ? null : JSON.stringify(init.body),
		},
	)
	return { status: result.status, body: JSON.parse(result.text) }
}

/** A run-unique suffix, so rules and destinations from earlier runs never collide. */
export const runTag = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
