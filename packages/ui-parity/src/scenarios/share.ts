import { act, clickButton, opsScenarios, SEEDED } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** A public link to the platform overview board, and a token that resolves to nothing. */
const share = opsScenarios("share", "Share")
const board = `/share/${SEEDED.platformShareToken}`
const HELD_MS = 60_000

export const shareArea: AreaModule = {
	area: "share",
	scenarios: [
		share("dashboard", "Shared platform overview", board),
		share("not-found", "Unknown share link", "/share/parity_share_unknown"),
		share("loading", "Shared platform overview, resolving (held)", board, {
			faults: { delays: { "sharePublic.resolve": HELD_MS } },
			settle: "held",
		}),
		share("widgets-loading", "Shared platform overview, widget data held", board, {
			faults: { delays: { "sharePublic.widgetData": HELD_MS } },
			settle: "held",
		}),
		share("unavailable", "Shared platform overview, resolve failing", board, {
			faults: {
				failures: {
					"sharePublic.resolve": {
						status: 503,
						body: {
							_tag: "@maple/http/errors/SharePersistenceError",
							message: "ui-parity: injected share failure",
						},
					},
				},
			},
		}),
		share("reload", "Shared platform overview, reloaded", board, {
			steps: act(clickButton("Reload")),
		}),
		share("refresh-menu", "Shared platform overview, auto-refresh menu open", board, {
			steps: act(clickButton("Auto-refresh off")),
		}),
		share("refresh-30s", "Shared platform overview, auto-refresh every 30s", board, {
			steps: act(clickButton("Auto-refresh off"), async (page) => {
				await page.getByRole("menuitemradio", { name: "30s" }).click()
				await page.waitForURL(/refresh=30/)
			}),
		}),
	],
}
