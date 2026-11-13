import type { VercelCostTeam } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "@maple/views/ui/alert"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { listRow } from "@maple/views/ui/list-row"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { AppRoute, hrefOf } from "../../route"
import { addTrail } from "./view-add-trail"
import { connectionStep, type ConnectionStepAction } from "../kit/connection-step"
import { Message } from "./message"
import { type Model, type VercelStep, vercelStepOf } from "./model"
import { COST_PROVIDERS, type CostProviderEntry } from "./providers"

type H = HtmlBuilder<Message>

/** Where a Vercel team is connected: the token is pasted and the team picked there. */
const CONNECT_VERCEL_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "vercel" } }))

/** Where the Vercel connection's token is replaced. */
export const VERCEL_INTEGRATION_HREF = hrefOf(AppRoute.Integrations({ search: { integration: "vercel" } }))

/** A provider's mark, as the dialog's rows lead with it. */
export const providerMark = (h: H, provider: CostProviderEntry): Html =>
	icon(h, provider.icon, { size: 18, className: cn("shrink-0", provider.iconClassName) })

/** The connected team as the row the step is about. */
const teamRow = (h: H, team: VercelCostTeam, isAdded: boolean): Html =>
	listRow(h, {
		leading: providerMark(h, COST_PROVIDERS.vercel),
		title: team.name,
		meta: team.slug,
		...(isAdded
			? { trailing: badge(h, { variant: "muted", size: "sm" }, ["Already added"]) }
			: undefined),
	})

/** What the step says about the connection it read. */
const connection = (h: H, model: Model, step: VercelStep): ReadonlyArray<Html> => {
	switch (step._tag) {
		case "NotConnected":
			return [
				typography(h, { size: "sm", tone: "muted", as: "p", className: "font-prose" }, [
					"No Vercel team is connected yet. Connect one, then add it here as a cost source.",
				]),
			]
		case "Added":
			return [
				teamRow(h, step.team, true),
				...(step.isTokenRejected
					? [
							alert(h, { variant: "warn", size: "sm" }, [
								alertDescription(h, [
									"Vercel rejected this team's token, so its cost has stopped syncing. Replace the token on the Vercel connection.",
								]),
							]),
						]
					: []),
			]
		case "TokenRejected":
			return [
				teamRow(h, step.team, false),
				alert(h, { variant: "warn", size: "sm" }, [
					alertDescription(h, [
						"Vercel rejected this team's token. Replace the token on the Vercel connection, then add the team here.",
					]),
				]),
			]
		case "Ready":
			return [
				teamRow(h, step.team, false),
				typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
					"Maple reads this month and the last at once, then every day from here on. Older months fill in after that, back to eleven months. The connection's token needs an Owner, Member, Developer, Security, Billing or Enterprise Viewer role on the team.",
				]),
				// A refusal is about the token: the way on is the connection, where it is replaced.
				...(model.vercelError === null
					? []
					: [
							alert(h, { variant: "crit", size: "sm" }, [
								alertDescription(h, [
									model.vercelError,
									textLink(
										h,
										{
											href: VERCEL_INTEGRATION_HREF,
											tone: "inherit",
											// The description is a column: the link keeps its own width.
											className: "self-start underline",
										},
										["Open the Vercel connection"],
									),
								]),
							]),
						]),
			]
	}
}

/** The step's primary action, by what the connection allows: add it, connect one, or fix its token. */
const primary = (model: Model, step: VercelStep): ConnectionStepAction<Message> | null => {
	const connection = { label: "Open the Vercel connection", href: VERCEL_INTEGRATION_HREF }
	switch (step._tag) {
		case "NotConnected":
			return { label: "Connect Vercel", href: CONNECT_VERCEL_HREF }
		case "Added":
			return step.isTokenRejected ? connection : null
		case "TokenRejected":
			return connection
		case "Ready":
			return {
				label: "Add source",
				onClick: Message.ClickedConfirmAddVercel(),
				isLoading: model.sourceWrite === "Saving",
			}
	}
}

/**
 * The dialog's Vercel step: the team the org has connected, added with one click. Nothing is
 * typed: the connection already holds the token.
 */
export const vercelStep = (h: H, model: Model, id: string): ReadonlyArray<Html> =>
	connectionStep(h, {
		dialogId: id,
		title: "Add Vercel",
		trail: addTrail(h, "Vercel"),
		description:
			"Maple reads what Vercel bills the team each day by product, project and region, plan fees included.",
		read: model.vercel.data,
		readingLabel: "Reading the Vercel connection",
		onRetry: Message.ClickedAddVercel(),
		content: (status) => connection(h, model, vercelStepOf(status)),
		primary: (status) => primary(model, vercelStepOf(status)),
		onBack: Message.ClickedBackToProviders(),
		isBusy: model.sourceWrite === "Saving",
	})
