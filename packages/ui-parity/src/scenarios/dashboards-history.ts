import type { Page } from "playwright"
import { act, clickButton, opsScenarios, SEEDED } from "./ops-kit.ts"
import type { Scenario } from "./types.ts"

/**
 * Version history on the platform board: the panel's timeline, a version previewed in place of
 * the live canvas, and the restore confirmation and write.
 */
const dashboard = opsScenarios("dashboards", "Dashboards")
const platform = `/dashboards/${SEEDED.platformDashboard}`

const clickMenuItem = (name: string) => (page: Page) => page.getByRole("menuitem", { name }).first().click()
const openHistory = [clickButton("More dashboard actions"), clickMenuItem("Version history")] as const
const previewV2 = (page: Page) => page.getByRole("button", { name: /Added “Error rate”/ }).click()

export const historyScenarios: ReadonlyArray<Scenario> = [
	dashboard("history", "Platform board: the version history panel", platform, { steps: act(...openHistory) }),
	dashboard("history-preview", "Platform board: an older version previewed", platform, {
		steps: act(...openHistory, previewV2),
	}),
	dashboard("history-restore-confirm", "Platform board: the restore confirmation", platform, {
		steps: act(...openHistory, previewV2, clickButton("Restore this version")),
	}),
	dashboard("history-restored", "Platform board: an older version restored", platform, {
		steps: act(...openHistory, previewV2, clickButton("Restore this version"), clickButton(/^Restore$/)),
	}),
	dashboard("history-closed", "Platform board: the history panel closed", platform, {
		steps: act(...openHistory, previewV2, clickButton("Close history panel")),
	}),
]
