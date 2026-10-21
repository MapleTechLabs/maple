import type { SupabaseIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { button, linkButton } from "../../ui/button"
import { badge } from "../../ui/display"
import { icon } from "../../ui/icon"
import { switchControl } from "../../ui/switch"
import { columnHead, dataTable, dataTableEmpty } from "../infra/kit/data-table"
import { relativeTime } from "../kit/relative-time"
import {
	SUPABASE_BRAND,
	SUPABASE_CONNECT_HINT,
	SUPABASE_NOT_CONFIGURED,
	supabaseOnRamp,
} from "../infra-integrations/supabase/connect"
import { Message } from "./message"
import type { Model } from "./model"
import { projectStatusLabel } from "./supabase"
import {
	connectedIntegrationCard,
	disconnectButton,
	integrationActions,
	integrationAlertNotice,
	integrationErrorNotice,
	integrationStatusCard,
} from "./view-integration-card"

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
			columnHead(h, { label: "Last seen", width: "w-28", align: "right" }),
			columnHead(h, { label: "Collect metrics", width: "w-28", align: "right" }),
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

const notice = (h: H, status: SupabaseIntegrationStatus): Html | null =>
	status.revoked
		? integrationAlertNotice(
				h,
				"Supabase no longer accepts Maple's access, so discovery and metrics are paused. Reconnect to resume.",
			)
		: status.lastDiscoveryError !== null
			? integrationErrorNotice(h, "Last discovery failed: ", status.lastDiscoveryError)
			: null

const actions = (h: H, model: Model, status: SupabaseIntegrationStatus): Html =>
	integrationActions(h, [
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
		disconnectButton(h, model),
	])

const byStatus = (h: H, model: Model, status: SupabaseIntegrationStatus, timeZone: string): Html => {
	if (!status.connected)
		return status.configured
			? supabaseOnRamp(h, SUPABASE_CONNECT_HINT, connectButton(h, model, "Connect Supabase"))
			: supabaseOnRamp(h, SUPABASE_NOT_CONFIGURED, null)
	return connectedIntegrationCard(h, model, {
		integration: "supabase",
		brand: SUPABASE_BRAND,
		title: "Supabase",
		badge: statusBadge(h, status),
		summary: summaryLine(h, model, status, timeZone),
		notice: notice(h, status),
		actions: actions(h, model, status),
		table: projectsTable(h, model, status, timeZone),
	})
}

export const supabaseCard = (h: H, model: Model, timeZone: string): Html =>
	integrationStatusCard(h, model.statuses.supabase, {
		name: "supabase",
		failureTitle: "Failed to load the Supabase integration",
		render: (status) => byStatus(h, model, status, timeZone),
	})
