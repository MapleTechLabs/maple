import type { VercelCostStatus } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { failureMessage } from "@maple/views/data/load-failure"
import { alert, alertDescription } from "@maple/views/ui/alert"
import { button, linkButton } from "@maple/views/ui/button"
import * as DialogView from "@maple/views/ui/dialog-view"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { listRow } from "@maple/views/ui/list-row"
import { spinner } from "@maple/views/ui/spinner"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { AppRoute, hrefOf } from "../../route"
import { Message } from "./message"
import type { Model } from "./model"
import { COST_PROVIDERS } from "./providers"

type H = HtmlBuilder<Message>

/** Where a Vercel team is connected: the token is pasted and the team picked there. */
const CONNECT_VERCEL_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "vercel" } }))

/** Where the Vercel connection and its token are changed. */
const VERCEL_INTEGRATION_HREF = hrefOf(AppRoute.Integrations({ search: { integration: "vercel" } }))

const note = (h: H, text: string): Html =>
	typography(h, { size: "sm", tone: "muted", as: "p", className: "font-prose" }, [text])

/** The connected team as the row the step is about. */
const teamRow = (h: H, team: NonNullable<VercelCostStatus["team"]>, isAdded: boolean): Html =>
	listRow(h, {
		leading: icon(h, COST_PROVIDERS.vercel.icon, {
			size: 18,
			className: cn("shrink-0", COST_PROVIDERS.vercel.iconClassName),
		}),
		title: team.name,
		meta: team.slug,
		...(isAdded
			? { trailing: badge(h, { variant: "muted", size: "sm" }, ["Already added"]) }
			: undefined),
	})

/** What the step says about the connection it read, and whether the team can be added. */
const connection = (h: H, model: Model, status: VercelCostStatus): ReadonlyArray<Html> => {
	if (status.team === null) {
		return [note(h, "No Vercel team is connected yet. Connect one, then add it here as a cost source.")]
	}
	if (status.added) return [teamRow(h, status.team, true)]
	if (status.authFailed) {
		return [
			teamRow(h, status.team, false),
			alert(h, { variant: "warn", size: "sm" }, [
				alertDescription(h, [
					"Vercel rejected this team's token. Connect the team again with a new token, then add it here.",
				]),
			]),
		]
	}
	return [
		teamRow(h, status.team, false),
		typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
			"Maple reads this month and the last at once, then every day from here on. Older months fill in after that, back to eleven months. The connection's token needs an Owner, Member, Developer or Billing role on the team.",
		]),
		...(model.vercelError === null
			? []
			: [alert(h, { variant: "crit", size: "sm" }, [alertDescription(h, [model.vercelError])])]),
	]
}

/** The step's primary action, by what the connection allows: add it, connect one, or fix its token. */
const primary = (h: H, model: Model): ReadonlyArray<Html> =>
	AsyncData.matchData(model.vercel.data, {
		onEmpty: () => [],
		onFailure: () => [],
		onData: (status) =>
			status.team === null
				? [linkButton(h, { href: CONNECT_VERCEL_HREF }, ["Connect Vercel"])]
				: status.added
					? []
					: status.authFailed
						? [linkButton(h, { href: VERCEL_INTEGRATION_HREF }, ["Open the Vercel connection"])]
						: [
								button(
									h,
									{
										isLoading: model.sourceWrite === "Saving",
										attributes: [h.OnClick(Message.ClickedConfirmAddVercel())],
									},
									["Add source"],
								),
							],
	})

/**
 * The dialog's Vercel step: the team the org has connected, added with one click. Nothing is
 * typed: the connection already holds the token.
 */
export const vercelStep = (h: H, model: Model, id: string): ReadonlyArray<Html> => {
	const isSaving = model.sourceWrite === "Saving"
	const back: ReadonlyArray<Attribute<Message>> = [h.OnClick(Message.ClickedBackToProviders())]
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
					onData: (status) => connection(h, model, status),
				}),
			),
		]),
		DialogView.dialogFooter(h, "dialog", [
			button(h, { variant: "outline", isDisabled: isSaving, attributes: back }, ["Back"]),
			...primary(h, model),
		]),
	]
}
