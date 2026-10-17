/**
 * `bun run preview:signin <pr>`: a signed-in link to PR preview `<pr>`, as the shared
 * preview reviewer.
 *
 * Trades `PREVIEW_SIGNIN_KEY` for a sign-in ticket at the preview's own API, the same
 * call the sign-in page's "PR preview" form makes. Run it under Infisical:
 * `infisical run --env dev -- bun run preview:signin 1336`. The ticket is single-use
 * and expires in two minutes.
 */
import { resolveMapleDomains } from "../packages/infra/src/cloudflare/stage.ts"

const prNumber = Number(process.argv[2])
if (!Number.isInteger(prNumber) || prNumber <= 0) {
	console.error("Usage: bun run preview:signin <pr-number>")
	process.exit(2)
}

const key = process.env.PREVIEW_SIGNIN_KEY?.trim()
if (!key) {
	console.error("PREVIEW_SIGNIN_KEY is not set. Run under `infisical run --env dev -- …`.")
	process.exit(2)
}

const domains = resolveMapleDomains({ stage: { kind: "pr", prNumber }, region: "us" })

const response = await fetch(`https://${domains.api}/api/auth/preview/sign-in`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ key }),
	signal: AbortSignal.timeout(30_000),
}).catch((error: unknown) => {
	console.error(`Could not reach https://${domains.api}: ${String(error)}`)
	return process.exit(1)
})
if (!response.ok) {
	console.error(`Preview sign-in failed: ${response.status} ${await response.text()}`)
	process.exit(1)
}

const { ticket } = (await response.json()) as { ticket: string }
console.log(`\nSigned-in link for PR #${prNumber} (single use, valid 2 minutes):\n`)
console.log(`  https://${domains.web}/sign-in?__clerk_ticket=${ticket}\n`)
