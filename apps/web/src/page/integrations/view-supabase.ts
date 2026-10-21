import type { SupabaseIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { button, linkButton } from "../../ui/button"
import { badge } from "../../ui/display"
import { errorState } from "../../ui/error-state"
import { icon } from "../../ui/icon"
import { item, itemContent, itemMedia } from "../../ui/item"
import { skeleton } from "../../ui/skeleton"
import { switchControl } from "../../ui/switch"
import { columnHead, dataTable, dataTableEmpty } from "../infra/kit/data-table"
import { relativeTime } from "../kit/relative-time"
import { integrationIconPlate } from "../infra-integrations/kit/integration-empty"
import { SUPABASE_BRAND, supabaseOnRamp } from "../infra-integrations/supabase/connect"
import { Message } from "./message"
import type { Model } from "./model"
import { projectStatusLabel } from "./supabase"
import { disconnectDialog } from "./view-disconnect"

// The Supabase card: connect, then the organization's projects and their switches.

type H = HtmlBuilder<Message>
type Project = SupabaseIntegrationStatus["projects"][number]

const connectButton = (h: H, model: Model, label: string): Html =>
	button(
		h,
		{
			isDisabled: model.connect.isStarting || model.disconnect.isPending,
			isLoading: model.connect.isStarting,
			attributes: [h.OnClick(Message.ClickedConnect())],
		},
		[icon(h, "SupabaseIcon"), label],
	)

const projectRow = (h: H, model: Model, project: Project, timeZone: string): Html => {
	const pill = projectStatusLabel(project.status)
	const isPending = model.supabaseCard.pendingRefs.includes(project.ref)
	return h.div(
		[
			h.Key(project.ref),
			h.Class("flex items-center gap-4 border-b border-border/40 px-4 py-2.5 text-sm last:border-0"),
		],
		[
			h.span(
				[h.Class("flex w-0 min-w-48 flex-1 flex-col")],
				[
					h.span(
						[h.Class("flex min-w-0 items-center gap-2")],
						[
							h.span([h.Class("truncate"), h.Title(project.name)], [project.name]),
							...(pill === null
								? []
								: [badge(h, { variant: pill.tone, className: "shrink-0" }, [pill.label])]),
						],
					),
					h.span([h.Class("font-mono text-2xs text-muted-foreground")], [project.ref]),
					...(project.logsEnabled && project.logsError !== null
						? [
								h.span(
									[
										h.Class(
											"line-clamp-1 text-2xs text-severity-error [overflow-wrap:anywhere]",
										),
										h.Title(project.logsError),
									],
									["Logs: ", project.logsError],
								),
							]
						: []),
				],
			),
			h.span([h.Class("w-32 shrink-0 truncate text-xs text-muted-foreground")], [project.region]),
			h.span(
				[h.Class("w-28 shrink-0 text-right text-xs text-muted-foreground")],
				[
					relativeTime(h, {
						value: project.lastSeenAt,
						nowMs: model.nowMs,
						timeZone,
						tooltip: "title",
						prefix: "seen",
					}),
				],
			),
			h.span(
				[h.Class("flex w-28 shrink-0 justify-end")],
				switchControl(h, {
					id: `supabase-metrics-${project.ref}`,
					inputId: `supabase-metrics-input-${project.ref}`,
					isChecked: project.metricsEnabled,
					isDisabled: isPending,
					ariaLabel: `Collect metrics for ${project.name}`,
					onToggle: Message.ToggledSupabaseMetrics({
						ref: project.ref,
						enabled: !project.metricsEnabled,
					}),
				}),
			),
			h.span(
				[h.Class("flex w-24 shrink-0 justify-end")],
				switchControl(h, {
					id: `supabase-logs-${project.ref}`,
					inputId: `supabase-logs-input-${project.ref}`,
					isChecked: project.logsEnabled,
					isDisabled: isPending,
					ariaLabel: `Collect logs for ${project.name}`,
					onToggle: Message.ToggledSupabaseLogs({
						ref: project.ref,
						enabled: !project.logsEnabled,
					}),
				}),
			),
		],
	)
}

const projectsTable = (h: H, model: Model, status: SupabaseIntegrationStatus, timeZone: string): Html =>
	dataTable(
		h,
		{ ariaLabel: "Supabase projects" },
		[
			columnHead(h, { label: "Project", width: "w-0 min-w-48 flex-1" }),
			columnHead(h, { label: "Region", width: "w-32" }),
			columnHead(h, { label: "Discovered", width: "w-28", align: "right" }),
			columnHead(h, { label: "Collect metrics", width: "w-28", align: "right" }),
			columnHead(h, { label: "Collect logs", width: "w-24", align: "right" }),
		],
		status.projects.length === 0
			? [dataTableEmpty(h, ["No projects in this organization yet. Sync after creating one."])]
			: status.projects.map((project) => projectRow(h, model, project, timeZone)),
	)

const statusBadge = (h: H, status: SupabaseIntegrationStatus): Html =>
	status.revoked
		? badge(h, { variant: "crit" }, ["Access revoked"])
		: status.lastDiscoveryError !== null
			? badge(h, { variant: "warn" }, ["Needs attention"])
			: badge(h, { variant: "ok" }, ["Connected"])

const summaryLine = (
	h: H,
	model: Model,
	status: SupabaseIntegrationStatus,
	timeZone: string,
): ReadonlyArray<Html | string> => {
	const collecting = status.projects.filter((project) => project.metricsEnabled).length
	return [
		status.organization === null ? "" : `${status.organization.name} · `,
		countLabel(status.projects.length, "project"),
		` · ${collecting} collecting metrics`,
		...(status.lastDiscoveryAt !== null
			? [
					" · ",
					relativeTime(h, {
						value: status.lastDiscoveryAt,
						nowMs: model.nowMs,
						timeZone,
						prefix: "synced",
					}),
				]
			: []),
	]
}

const notice = (h: H, status: SupabaseIntegrationStatus): ReadonlyArray<Html> =>
	status.revoked
		? [
				h.p(
					[h.Class("text-xs text-severity-error"), h.Role("alert")],
					[
						"Supabase no longer accepts Maple's access, so discovery and metrics are paused. Reconnect to resume.",
					],
				),
			]
		: status.lastDiscoveryError !== null
			? [
					h.p(
						[
							h.Class("line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]"),
							h.Title(status.lastDiscoveryError),
						],
						["Last discovery failed: ", status.lastDiscoveryError],
					),
				]
			: []

const actions = (h: H, model: Model, status: SupabaseIntegrationStatus): Html =>
	h.div(
		[h.Class("flex flex-wrap gap-2")],
		[
			status.revoked
				? button(
						h,
						{
							size: "sm",
							isLoading: model.connect.isStarting,
							attributes: [h.OnClick(Message.ClickedConnect())],
						},
						["Reconnect"],
					)
				: linkButton(h, { size: "sm", href: hrefOf(AppRoute.InfraSupabase({ search: {} })) }, [
						"View metrics",
					]),
			...(status.revoked
				? []
				: [
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								isLoading: model.supabaseCard.isSyncing,
								attributes: [h.OnClick(Message.ClickedSupabaseSync())],
							},
							["Sync now"],
						),
					]),
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
	)

const connectedView = (h: H, model: Model, status: SupabaseIntegrationStatus, timeZone: string): Html =>
	h.div(
		[h.Class("flex flex-col gap-4")],
		[
			item(h, { variant: "card", className: "items-start gap-4 p-4" }, [
				itemMedia(h, {}, [integrationIconPlate(h, SUPABASE_BRAND)]),
				itemContent(
					h,
					[
						h.div(
							[h.Class("flex flex-wrap items-center gap-2")],
							[h.h3([h.Class("text-sm font-semibold")], ["Supabase"]), statusBadge(h, status)],
						),
						h.p(
							[h.Class("text-xs text-muted-foreground")],
							summaryLine(h, model, status, timeZone),
						),
						...notice(h, status),
						actions(h, model, status),
						disconnectDialog(h, model, "supabase"),
					],
					"gap-2",
				),
			]),
			projectsTable(h, model, status, timeZone),
		],
	)

const byStatus = (h: H, model: Model, status: SupabaseIntegrationStatus, timeZone: string): Html => {
	if (status.connected) return connectedView(h, model, status, timeZone)
	return status.configured
		? supabaseOnRamp(
				h,
				"Authorize one Supabase organization. Its projects appear here, and you choose which ones Maple collects metrics from.",
				connectButton(h, model, "Connect Supabase"),
			)
		: supabaseOnRamp(
				h,
				"Supabase is not set up on this Maple deployment yet. Its Supabase OAuth app needs to be configured first.",
				null,
			)
}

export const supabaseCard = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.match(model.statuses.supabase.data, {
		onIdle: () => skeleton(h, "h-32 w-full rounded-md"),
		onLoading: () => skeleton(h, "h-32 w-full rounded-md"),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load the Supabase integration",
				onRetry: Message.ClickedRetryStatus({ name: "supabase" }),
			}),
		onStale: ({ data }) => byStatus(h, model, data, timeZone),
		onRefreshing: (data) => byStatus(h, model, data, timeZone),
		onSuccess: (data) => byStatus(h, model, data, timeZone),
	})
