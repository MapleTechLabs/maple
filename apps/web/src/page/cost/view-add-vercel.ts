import type { VercelCostTeam } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureMessage } from "@maple/views/data/load-failure"
import { alert, alertDescription } from "@maple/views/ui/alert"
import { button, linkButton } from "@maple/views/ui/button"
import * as DialogView from "@maple/views/ui/dialog-view"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { listRow } from "@maple/views/ui/list-row"
import { spinner } from "@maple/views/ui/spinner"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { AppRoute, hrefOf } from "../../route"
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

const connectionLink = (h: H): Html =>
	linkButton(h, { href: VERCEL_INTEGRATION_HREF }, ["Open the Vercel connection"])

/** The step's primary action, by what the connection allows: add it, connect one, or fix its token. */
const primary = (h: H, model: Model, step: VercelStep): ReadonlyArray<Html> => {
	switch (step._tag) {
		case "NotConnected":
			return [linkButton(h, { href: CONNECT_VERCEL_HREF }, ["Connect Vercel"])]
		case "Added":
			return step.isTokenRejected ? [connectionLink(h)] : []
		case "TokenRejected":
			return [connectionLink(h)]
		case "Ready":
			return [
				button(
					h,
					{
						isLoading: model.sourceWrite === "Saving",
						attributes: [h.OnClick(Message.ClickedConfirmAddVercel())],
					},
					["Add source"],
				),
			]
	}
}

/**
 * The dialog's Vercel step: the team the org has connected, added with one click. Nothing is
 * typed: the connection already holds the token.
 */
export const vercelStep = (h: H, model: Model, id: string): ReadonlyArray<Html> => {
	const step = AsyncData.matchData(model.vercel.data, {
		onEmpty: () => null,
		onFailure: () => null,
		onData: vercelStepOf,
	})
	return [
		DialogView.dialogHeader(h, "dialog", [
			DialogView.dialogTitle(h, "dialog", id, "Add Vercel"),
			DialogView.dialogDescription(
				h,
				"dialog",
				id,
				"Maple reads what Vercel bills the team each day by product, project and region, plan fees included.",
			),
		]),
		DialogView.dialogPanel(h, "dialog", id, [
			vstack(
				h,
				{ gap: "3" },
				AsyncData.matchData(model.vercel.data, {
					onEmpty: () => [
						hstack(h, { gap: "2" }, [
							spinner(h, undefined, 14, true),
							typography(h, { size: "sm", tone: "muted" }, ["Reading the Vercel connection"]),
						]),
					],
					onFailure: (failure) => [
						alert(h, { variant: "crit", size: "sm" }, [
							alertDescription(h, [failureMessage(failure)]),
						]),
						hstack(h, {}, [
							button(
								h,
								{
									variant: "outline",
									size: "sm",
									attributes: [h.OnClick(Message.ClickedAddVercel())],
								},
								["Try again"],
							),
						]),
					],
					onData: (status) => connection(h, model, vercelStepOf(status)),
				}),
			),
		]),
		DialogView.dialogFooter(h, "dialog", [
			button(
				h,
				{
					variant: "outline",
					isDisabled: model.sourceWrite === "Saving",
					attributes: [h.OnClick(Message.ClickedBackToProviders())],
				},
				["Back"],
			),
			...(step === null ? [] : primary(h, model, step)),
		]),
	]
}
