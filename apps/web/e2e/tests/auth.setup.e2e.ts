import { String as Str } from "effect"
import { expect, test as setup } from "playwright/test"

import { apiUrl, reviewerState } from "./support"

// The shared preview reviewer (docs/pr-previews.md). The key is traded for a single-use,
// two-minute Clerk ticket here in the runner, so it never reaches the page.
setup("sign in as the preview reviewer", async ({ page, baseURL }) => {
	const rawKey = process.env.PREVIEW_SIGNIN_KEY
	const key = rawKey === undefined ? undefined : Str.trim(rawKey)
	if (!key) throw new Error("PREVIEW_SIGNIN_KEY is not set; run under `infisical run --env dev`.")
	const response = await fetch(`${apiUrl(baseURL ?? "")}/api/auth/preview/sign-in`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key }),
	})
	if (!response.ok) throw new Error(`Preview sign-in failed: HTTP ${response.status}`)
	const { ticket }: { ticket: string } = await response.json()

	await page.goto(`/sign-in?__clerk_ticket=${encodeURIComponent(ticket)}`)
	await page.waitForURL(/^(?!.*\/sign-in)/, { timeout: 30_000 })
	await expect(page).toHaveURL(/^(?!.*\/sign-in)/)
	await page.context().storageState({ path: reviewerState })
})
