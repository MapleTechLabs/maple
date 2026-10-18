import type { Page } from "playwright"
import { act, clickButton, opsScenarios, SEEDED } from "./ops-kit.ts"
import type { Scenario } from "./types.ts"

/**
 * Sharing from the board: the Share dialog's access ladder and link, its writes (share, stop,
 * replace), and the per-chart Embed dialog on a public and an org-only board.
 */
const dashboard = opsScenarios("dashboards", "Dashboards")
const platform = `/dashboards/${SEEDED.platformDashboard}`
const payment = `/dashboards/${SEEDED.paymentDashboard}`
const unshared = `/dashboards/${SEEDED.sectionsDashboard}`

const clickMenuItem = (name: string) => (page: Page) => page.getByRole("menuitem", { name }).first().click()
const openShare = [clickButton("More dashboard actions"), clickMenuItem("Share…")] as const
/** The access ladder's radios, in order: Not shared, organization, anyone with the link. */
const pickAccess = (index: number) => (page: Page) => page.getByRole("radio").nth(index).click()
const openEmbed = [
	(page: Page) => page.getByRole("button", { name: "Widget actions" }).first().click(),
	clickMenuItem("Embed chart"),
] as const

export const shareScenarios: ReadonlyArray<Scenario> = [
	dashboard("share-dialog", "Platform board: the Share dialog on a public board", platform, {
		steps: act(...openShare),
	}),
	dashboard("share-dialog-unshared", "Grouped board: the Share dialog on an unshared board", unshared, {
		steps: act(...openShare),
	}),
	dashboard("share-made-public", "Grouped board: shared with anyone with the link", unshared, {
		steps: act(...openShare, pickAccess(2)),
	}),
	dashboard("share-stopped", "Platform board: sharing stopped", platform, {
		steps: act(...openShare, pickAccess(0)),
	}),
	dashboard("share-replace-confirm", "Platform board: replacing the share link asks first", platform, {
		steps: act(...openShare, clickButton("Replace")),
	}),
	dashboard("share-replaced", "Platform board: the share link replaced", platform, {
		steps: act(...openShare, clickButton("Replace"), clickButton("Replace link")),
	}),
	dashboard("share-embed", "Platform board: a chart's embed link and URL options", platform, {
		steps: act(...openEmbed),
	}),
	dashboard("share-embed-react", "Platform board: the embed snippet as React", platform, {
		steps: act(...openEmbed, (page) => page.getByRole("tab", { name: "React" }).click()),
	}),
	dashboard("share-embed-org", "Payment board: embedding a chart on an org-only board", payment, {
		steps: act(...openEmbed),
	}),
	dashboard("share-embed-made-public", "Payment board: made public from the embed dialog", payment, {
		steps: act(...openEmbed, clickButton("Make dashboard public")),
	}),
	// The traces list cannot render in a shared view: its "Embed chart" is disabled, with a tooltip.
	dashboard("share-embed-unsupported", "Platform board: the disabled Embed chart item's tooltip", platform, {
		steps: act(
			(page) => page.getByRole("button", { name: "Widget actions" }).last().click(),
			// A disabled item takes no pointer events: the hover lands on its tooltip wrapper.
			(page) => page.getByRole("menuitem", { name: "Embed chart" }).hover({ force: true }),
			(page) => page.getByText("This widget can't be shown in shared views").waitFor(),
		),
	}),
]
