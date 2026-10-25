import { test } from "@e2e-dev/web"
import { expect } from "e2e"

import { apiUrl } from "./support"

// The shared preview reviewer (docs/pr-previews.md). The key is traded for a single-use,
// two-minute Clerk ticket here in the runner, so it never reaches the page or the model.
test.setup(
	"sign in as the preview reviewer",
	{ sessions: ["reviewer"] },
	async ({ app, browser, session }) => {
		const key = process.env.PREVIEW_SIGNIN_KEY?.trim()
		if (!key) throw new Error("PREVIEW_SIGNIN_KEY is not set; run under `infisical run --env dev`.")
		const response = await fetch(`${apiUrl(app.baseUrl ?? "")}/api/auth/preview/sign-in`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key }),
		})
		if (!response.ok) throw new Error(`Preview sign-in failed: HTTP ${response.status}`)
		const { ticket }: { ticket: string } = await response.json()

		await app.open(`/sign-in?__clerk_ticket=${encodeURIComponent(ticket)}`)
		await browser.waitForURL(/^(?!.*\/sign-in)/, { timeout: 30_000 })
		await expect(browser).toHaveURL(/^(?!.*\/sign-in)/)
		await session.save("reviewer")
	},
)
