/**
 * `bun run dev:signin [email]` — sign a local browser into the dev Clerk
 * instance without typing a password.
 *
 * Clerk's own sign-in tickets do the work: the Backend API mints a one-shot
 * token for a user, and `<SignIn>` at `/sign-in` completes the session when it
 * sees that token in `__clerk_ticket`. No app-side auth bypass exists, and none
 * should — this is the same flow Clerk uses for magic links.
 *
 * The script refuses to run against anything but a development instance
 * (`sk_test_…`), so it cannot mint a session for a real user on a live one.
 */
const CLERK_API = "https://api.clerk.com/v1"

const DEFAULT_EMAIL = "david+clerk_test@gmail.com"
const TICKET_TTL_SECONDS = 600

const secretKey = process.env.CLERK_SECRET_KEY
if (!secretKey) {
	console.error("CLERK_SECRET_KEY is not set. Run from the repo root so .env.local is loaded.")
	process.exit(2)
}
if (!secretKey.startsWith("sk_test_")) {
	console.error(
		"CLERK_SECRET_KEY is not a development key (sk_test_…). This script only signs in to dev instances.",
	)
	process.exit(2)
}

const email = process.argv[2] ?? process.env.MAPLE_DEV_SIGNIN_EMAIL ?? DEFAULT_EMAIL

// The REST API directly rather than `@clerk/backend`: the SDK is a dependency of
// `apps/api`, not of the repo root, and two calls do not earn one at the root.
const clerkFetch = async (path: string, init?: RequestInit) => {
	const response = await fetch(`${CLERK_API}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${secretKey}`,
			"content-type": "application/json",
			...init?.headers,
		},
	})
	if (!response.ok) {
		console.error(`Clerk ${init?.method ?? "GET"} ${path} failed: ${response.status}`)
		console.error(await response.text())
		process.exit(1)
	}
	return response.json()
}

const users = (await clerkFetch(`/users?email_address=${encodeURIComponent(email)}`)) as Array<{
	id: string
}>
const user = users[0]
if (!user) {
	console.error(`No user with email ${email} on this Clerk instance.`)
	process.exit(1)
}

const ticket = (await clerkFetch("/sign_in_tokens", {
	method: "POST",
	body: JSON.stringify({ user_id: user.id, expires_in_seconds: TICKET_TTL_SECONDS }),
})) as { token: string }

// Both shapes of local web: the portless stack (`bun dev`) and the raw Vite
// port (`bun --filter=@maple/web dev`).
const targets = process.env.MAPLE_DEV_WEB_URL
	? [process.env.MAPLE_DEV_WEB_URL]
	: ["https://web.localhost", "http://localhost:3471"]

console.log(`\nSigned-in link for ${email} (valid ${TICKET_TTL_SECONDS / 60} minutes, single use):\n`)
for (const base of targets) {
	console.log(`  ${base}/sign-in?__clerk_ticket=${ticket.token}`)
}
console.log("\nOpen one in the browser. It lands on the app already signed in.\n")
