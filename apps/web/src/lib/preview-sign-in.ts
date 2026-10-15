import { apiBaseUrl } from "@/lib/services/common/api-base-url"
import { tracedFetch } from "@/lib/services/common/telemetry"

const PREVIEW_SIGN_IN_URL = `${apiBaseUrl}/api/auth/preview/sign-in`

/** The sign-in route waits on this probe, so a slow API must not hold back Clerk's card. */
const STATUS_TIMEOUT_MS = 3_000

/** PR previews answer `enabled: true`; everywhere else, or on any failure or timeout, it is false. */
export const loadPreviewSignInEnabled = () =>
	tracedFetch("maple-api", PREVIEW_SIGN_IN_URL, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) })
		.then((response) => (response.ok ? (response.json() as Promise<{ enabled?: unknown }>) : null))
		.then((body) => body?.enabled === true)
		.catch(() => false)

export async function requestPreviewTicket(key: string) {
	const response = await tracedFetch("maple-api", PREVIEW_SIGN_IN_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key }),
	})
	if (!response.ok) {
		const errorBody = (await response.json().catch(() => null)) as { message?: string } | null
		throw new Error(errorBody?.message ?? "Preview sign-in failed")
	}
	return ((await response.json()) as { ticket: string }).ticket
}

/** Reload `/sign-in` with the ticket; Clerk's `<SignIn>` redeems `__clerk_ticket` on mount. */
export const openTicketSignIn = (ticket: string, redirectUrl: string | null) => {
	const params = new URLSearchParams({ __clerk_ticket: ticket })
	if (redirectUrl) params.set("redirect_url", redirectUrl)
	window.location.assign(`/sign-in?${params.toString()}`)
}
