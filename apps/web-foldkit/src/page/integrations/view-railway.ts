import type { RailwayIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { button, linkButton } from "../../ui/button"
import { badge } from "../../ui/display"
import { errorState } from "../../ui/error-state"
import { item, itemContent, itemMedia } from "../../ui/item"
import { skeleton } from "../../ui/skeleton"
import { spinner } from "../../ui/spinner"
import { truncatedText } from "../../ui/truncated-text"
import { columnHead, dataTable, dataTableEmpty } from "../infra/kit/data-table"
import { relativeTime } from "../kit/relative-time"
import { integrationIconPlate, RAILWAY_ACCENT } from "../infra-integrations/kit/integration-empty"
import {
	railwayConnectCard,
	railwayTokenForm,
	type TokenFormConfig,
} from "../infra-integrations/railway/list/view-connect"
import { Message } from "./message"
import type { Model } from "./model"
import { unsyncedEnvironments } from "./railway"
import { disconnectDialog } from "./view-disconnect"

// `RailwayIntegrationCard`.

type H = HtmlBuilder<Message>

const BRAND = { icon: "RailwayIcon", accent: RAILWAY_ACCENT, iconClassName: "text-foreground" } as const

const formConfig = (mode: "connect" | "rotate", canCancel: boolean): TokenFormConfig<Message> => ({
	mode,
	onField: (message) => Message.GotRailwayTokenMessage({ message }),
	onSubmit: Message.SubmittedRailwayToken(),
	onCancel: canCancel ? Message.ClickedRailwayRotateCancel() : undefined,
})

const environmentsTable = (h: H, model: Model, status: RailwayIntegrationStatus, timeZone: string): Html =>
	dataTable(
		h,
		{ ariaLabel: "Railway environments" },
		[
			columnHead(h, { label: "Environment", width: "w-0 min-w-48 flex-1" }),
			columnHead(h, { label: "Services", width: "w-20", align: "right" }),
			columnHead(h, { label: "Last sync", width: "w-32", align: "right" }),
		],
		status.environments.length === 0
			? [dataTableEmpty(h, ["This token can't see any projects yet."])]
			: status.environments.map((environment) =>
					h.div(
						[
							h.Class(
								"flex items-center gap-4 border-b border-border/40 px-4 py-2.5 text-sm last:border-0",
							),
						],
						[
							h.span(
								[h.Class("flex w-0 min-w-48 flex-1 flex-col")],
								[
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
													className: "text-xs text-severity-error",
												}),
											]
										: []),
								],
							),
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
											: h.span(
													[h.Class("inline-flex items-center gap-1")],
													[spinner(h, undefined, 12), "Syncing"],
												),
								],
							),
						],
					),
				),
	)

const connectedView = (h: H, model: Model, status: RailwayIntegrationStatus, timeZone: string): Html => {
	const card = model.railwayCard
	const failing = status.environments.filter((environment) => environment.lastError !== null).length
	const queued = status.authFailed ? 0 : unsyncedEnvironments(status)
	return h.div(
		[h.Class("flex flex-col gap-4")],
		[
			item(h, { variant: "card", className: "items-start gap-4 p-4" }, [
				itemMedia(h, {}, [integrationIconPlate(h, BRAND)]),
				itemContent(
					h,
					[
						h.div(
							[h.Class("flex flex-wrap items-center gap-2")],
							[
								h.h3([h.Class("text-sm font-semibold")], ["Railway"]),
								status.authFailed
									? badge(h, { variant: "crit" }, ["Token rejected"])
									: failing > 0
										? badge(h, { variant: "warn" }, ["Needs attention"])
										: badge(h, { variant: "ok" }, ["Connected"]),
							],
						),
						h.p(
							[h.Class("text-xs text-muted-foreground")],
							[
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
						),
						...(status.authFailed
							? [
									h.p(
										[h.Class("text-xs text-severity-error"), h.Role("alert")],
										[
											"Railway rejected the saved token, so polling is paused. Paste a new token to resume.",
										],
									),
								]
							: status.lastError !== null
								? [
										h.p(
											[
												h.Class(
													"line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]",
												),
												h.Title(status.lastError),
											],
											["Last error: ", status.lastError],
										),
									]
								: []),
						card.isRotating || status.authFailed
							? railwayTokenForm(h, card.connect, formConfig("rotate", !status.authFailed))
							: h.div(
									[h.Class("flex flex-wrap gap-2")],
									[
										linkButton(
											h,
											{
												size: "sm",
												href: hrefOf(AppRoute.InfraRailway({ search: {} })),
											},
											["View metrics"],
										),
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
											["Replace token"],
										),
										button(
											h,
											{
												size: "sm",
												variant: "outline",
												isLoading: model.disconnect.isPending,
												attributes: [h.OnClick(Message.ClickedDisconnect())],
											},
											["Disconnect"],
										),
									],
								),
						disconnectDialog(h, model, "railway"),
					],
					"gap-2",
				),
			]),
			environmentsTable(h, model, status, timeZone),
		],
	)
}

export const railwayCard = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.match(model.statuses.railway.data, {
		onIdle: () => skeleton(h, "h-32 w-full rounded-md"),
		onLoading: () => skeleton(h, "h-32 w-full rounded-md"),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load the Railway integration",
				onRetry: Message.ClickedRetryStatus({ name: "railway" }),
			}),
		onStale: ({ data }) => byStatus(h, model, data, timeZone),
		onRefreshing: (data) => byStatus(h, model, data, timeZone),
		onSuccess: (data) => byStatus(h, model, data, timeZone),
	})

const byStatus = (h: H, model: Model, status: RailwayIntegrationStatus, timeZone: string): Html =>
	status.connected
		? connectedView(h, model, status, timeZone)
		: railwayConnectCard(h, model.railwayCard.connect, formConfig("connect", false))
