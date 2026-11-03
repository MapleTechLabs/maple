import type { RailwayIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { button, linkButton } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { spinner } from "@maple/views/ui/spinner"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { columnHead, dataTable, dataTableEmpty } from "../infra/kit/data-table"
import { relativeTime } from "../kit/relative-time"
import { RAILWAY_ACCENT } from "./catalog"
import { railwayTokenForm } from "./view-railway-token"
import { integrationNotice } from "./kit/notice"
import { Message } from "./message"
import type { Model } from "./model"
import { unsyncedEnvironments } from "./railway"
import {
	connectedIntegrationCard,
	disconnectButton,
	integrationActions,
	integrationAlertNotice,
	integrationErrorNotice,
	integrationStatusCard,
} from "./view-integration-card"
import { typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { stripClass } from "@maple/views/ui/rule"
import { columnClass } from "@maple/views/ui/column"
import { Array as Arr } from "effect"

// `RailwayIntegrationCard`.

type H = HtmlBuilder<Message>

const BRAND = { icon: "RailwayIcon", accent: RAILWAY_ACCENT, iconClassName: "text-foreground" } as const

const environmentsTable = (h: H, model: Model, status: RailwayIntegrationStatus, timeZone: string): Html =>
	dataTable(
		h,
		{ ariaLabel: "Railway environments" },
		[
			columnHead(h, { label: "Environment", width: columnClass({ min: "48" }) }),
			columnHead(h, { label: "Services", width: "w-20", align: "right" }),
			columnHead(h, { label: "Last sync", width: "w-32", align: "right" }),
		],
		status.environments.length === 0
			? [dataTableEmpty(h, ["This token can't see any projects yet."])]
			: Arr.map(status.environments, (environment) =>
					hstack(
						h,
						{
							gap: "4",
							className: typographyClass({
								size: "sm",
								className: stripClass("row"),
							}),
						},
						[
							vstack(h, { grow: true, as: "span", className: "w-0 min-w-48" }, [
								h.span(
									[h.Class("truncate")],
									[
										environment.projectName,
										h.span(
											[h.Class("text-muted-foreground")],
											[" ", "/ ", environment.environmentName],
										),
									],
								),
								...(environment.lastError !== null
									? [
											truncatedText(h, {
												text: environment.lastError,
												className: typographyClass({ size: "xs", tone: "error" }),
											}),
										]
									: []),
							]),
							h.span(
								[h.Class("w-20 shrink-0 text-right tabular-nums text-muted-foreground")],
								[String(environment.serviceCount)],
							),
							h.span(
								[h.Class("w-32 shrink-0 text-right text-xs text-muted-foreground")],
								[
									environment.lastSyncedAt !== null
										? relativeTime(h, {
												value: environment.lastSyncedAt,
												nowMs: model.nowMs,
												timeZone,
												tooltip: "title",
											})
										: environment.lastError !== null
											? "Failed"
											: hstack(h, { gap: "1", inline: true, as: "span" }, [
													spinner(h, undefined, 12),
													"Syncing",
												]),
								],
							),
						],
					),
				),
	)

const connectedView = (h: H, model: Model, status: RailwayIntegrationStatus, timeZone: string): Html => {
	const card = model.railwayCard
	const failing = Arr.filter(status.environments, (environment) => environment.lastError !== null).length
	const queued = status.authFailed ? 0 : unsyncedEnvironments(status)
	return connectedIntegrationCard(h, model, {
		integration: "railway",
		brand: BRAND,
		title: "Railway",
		badge: status.authFailed
			? badge(h, { variant: "crit" }, ["Token rejected"])
			: failing > 0
				? badge(h, { variant: "warn" }, ["Needs attention"])
				: badge(h, { variant: "ok" }, ["Connected"]),
		summary: [
			status.workspaceNames !== null && status.workspaceNames !== ""
				? `${status.workspaceNames} · `
				: "",
			countLabel(status.environments.length, "environment"),
			...(status.lastSyncedAt !== null
				? [
						" · ",
						relativeTime(h, {
							value: status.lastSyncedAt,
							nowMs: model.nowMs,
							timeZone,
							prefix: "synced",
						}),
					]
				: []),
			queued > 0 ? ` · ${queued} waiting for their first sync` : "",
		],
		notice: status.authFailed
			? integrationAlertNotice(
					h,
					"Railway rejected the saved token, so polling is paused. Paste a new token to resume.",
				)
			: status.lastError !== null
				? integrationErrorNotice(h, "Last error: ", status.lastError)
				: null,
		actions:
			card.isRotating || status.authFailed
				? railwayTokenForm(h, card.connect, { mode: "rotate", canCancel: !status.authFailed })
				: integrationActions(h, [
						linkButton(h, { size: "sm", href: hrefOf(AppRoute.InfraRailway({ search: {} })) }, [
							"View metrics",
						]),
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								isLoading: card.isSyncing,
								attributes: [h.OnClick(Message.ClickedRailwaySync())],
							},
							["Sync now"],
						),
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								attributes: [h.OnClick(Message.ClickedRailwayRotate())],
							},
							["Update credential"],
						),
						disconnectButton(h, model),
					]),
		table: environmentsTable(h, model, status, timeZone),
	})
}

export const railwayCard = (h: H, model: Model, timeZone: string): Html =>
	integrationStatusCard(h, model.statuses.railway, {
		name: "railway",
		failureTitle: "Couldn't load the Railway integration",
		render: (status) => byStatus(h, model, status, timeZone),
	})

const byStatus = (h: H, model: Model, status: RailwayIntegrationStatus, timeZone: string): Html =>
	status.connected ? connectedView(h, model, status, timeZone) : railwayReconnect(h)

/** A source page whose token was removed: the way back is the connect flow. */
const railwayReconnect = (h: H): Html =>
	integrationNotice(h, {
		message: "Railway is not connected.",
		action: linkButton(
			h,
			{ size: "sm", href: hrefOf(AppRoute.SourcesNew({ search: { integration: "railway" } })) },
			["Reconnect"],
		),
	})
