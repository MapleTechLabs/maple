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
import { type Model, type PlanetScaleStep, planetScaleStepOf } from "./model"
import { COST_PROVIDERS } from "./providers"

type H = HtmlBuilder<Message>

/** Where PlanetScale is connected for the first time: it is authorized and its organization picked there. */
const CONNECT_PLANETSCALE_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "planetscale" } }))

/** Where the PlanetScale connection is managed, and authorized again. */
export const PLANETSCALE_INTEGRATION_HREF = hrefOf(
	AppRoute.Integrations({ search: { integration: "planetscale" } }),
)

/** What removing the source says: the connection it read through stays. */
export const PLANETSCALE_REMOVE = {
	title: "Remove the PlanetScale source?",
	description:
		"Maple stops reading the organization's invoices, and its cost leaves this page. The PlanetScale connection stays. Adding the source again reads the last year again.",
} as const

const RECONNECT = "Reconnect PlanetScale"

/** The connected organization as the row the step is about. */
const organizationRow = (h: H, organization: string, isAdded: boolean): Html =>
	listRow(h, {
		leading: icon(h, COST_PROVIDERS.planetscale.icon, {
			size: 18,
			className: cn("shrink-0", COST_PROVIDERS.planetscale.iconClassName),
		}),
		title: organization,
		meta: "PlanetScale organization",
		...(isAdded
			? { trailing: badge(h, { variant: "muted", size: "sm" }, ["Already added"]) }
			: undefined),
	})

const reconnectLink = (h: H): Html =>
	textLink(
		h,
		{
			href: PLANETSCALE_INTEGRATION_HREF,
			tone: "inherit",
			// The description is a column: the link keeps its own width.
			className: "self-start underline",
		},
		[RECONNECT],
	)

/** What the step says about the connection it read. */
const connection = (h: H, model: Model, step: PlanetScaleStep): ReadonlyArray<Html> => {
	switch (step._tag) {
		case "NotConnected":
			return [
				typography(h, { size: "sm", tone: "muted", as: "p", className: "font-prose" }, [
					"PlanetScale is not connected yet. Connect it, then add its organization here as a cost source.",
				]),
			]
		case "Added":
			return [
				organizationRow(h, step.organization, true),
				...(step.needsReconnect
					? [
							alert(h, { variant: "warn", size: "sm" }, [
								alertDescription(h, [
									"The PlanetScale connection can no longer read invoices, so this source has stopped syncing. Reconnect PlanetScale to grant access to invoices.",
								]),
							]),
						]
					: []),
			]
		case "NeedsReconnect":
			return [
				organizationRow(h, step.organization, false),
				alert(h, { variant: "warn", size: "sm" }, [
					alertDescription(h, [
						"Reconnect PlanetScale to grant access to invoices. This connection was authorized without it. Then add the organization here.",
					]),
				]),
			]
		case "Ready":
			return [
				organizationRow(h, step.organization, false),
				typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
					"Maple reads this month and the last at once, then the year before, and every day from here on. Nothing is pasted: it reads through the PlanetScale connection.",
				]),
				...(model.planetscaleError === null
					? []
					: [
							alert(h, { variant: "crit", size: "sm" }, [
								alertDescription(h, [
									model.planetscaleError.message,
									// Only a grant to authorize again is fixed on the connection.
									...(model.planetscaleError.needsReconnect ? [reconnectLink(h)] : []),
								]),
							]),
						]),
			]
	}
}

const reconnectButton = (h: H): Html => linkButton(h, { href: PLANETSCALE_INTEGRATION_HREF }, [RECONNECT])

/** The step's primary action, by what the connection allows: add it, connect one, or authorize it again. */
const primary = (h: H, model: Model, step: PlanetScaleStep): ReadonlyArray<Html> => {
	switch (step._tag) {
		case "NotConnected":
			return [linkButton(h, { href: CONNECT_PLANETSCALE_HREF }, ["Connect PlanetScale"])]
		case "Added":
			return step.needsReconnect ? [reconnectButton(h)] : []
		case "NeedsReconnect":
			return [reconnectButton(h)]
		case "Ready":
			return [
				button(
					h,
					{
						isLoading: model.sourceWrite === "Saving",
						attributes: [h.OnClick(Message.ClickedConfirmAddPlanetScale())],
					},
					["Add source"],
				),
			]
	}
}

/**
 * The dialog's PlanetScale step: the organization the org has connected, added with one click.
 * Nothing is typed: the connection already holds the authorization.
 */
export const planetScaleStep = (h: H, model: Model, id: string): ReadonlyArray<Html> => {
	const step = AsyncData.matchData(model.planetscale.data, {
		onEmpty: () => null,
		onFailure: () => null,
		onData: planetScaleStepOf,
	})
	return [
		DialogView.dialogHeader(h, "dialog", [
			DialogView.dialogTitle(h, "dialog", id, "Add PlanetScale"),
			DialogView.dialogDescription(
				h,
				"dialog",
				id,
				"PlanetScale bills by the month, so Maple spreads each invoice line evenly over the days its branch ran.",
			),
		]),
		DialogView.dialogPanel(h, "dialog", id, [
			vstack(
				h,
				{ gap: "3" },
				AsyncData.matchData(model.planetscale.data, {
					onEmpty: () => [
						hstack(h, { gap: "2" }, [
							spinner(h, undefined, 14, true),
							typography(h, { size: "sm", tone: "muted" }, [
								"Reading the PlanetScale connection",
							]),
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
									attributes: [h.OnClick(Message.ClickedAddPlanetScale())],
								},
								["Try again"],
							),
						]),
					],
					onData: (status) => connection(h, model, planetScaleStepOf(status)),
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
