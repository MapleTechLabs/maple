import type { SupabaseIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { formatRelativeShortFrom, toEpochMs } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { button, linkButton } from "../../ui/button"
import { badge } from "../../ui/display"
import { icon } from "../../ui/icon"
import { switchControl } from "../../ui/switch"
import { columnHead, dataTable, dataTableEmpty } from "../infra/kit/data-table"
import { relativeTime } from "../kit/relative-time"
import { healthPill, isReadPending, lifecycleOf, projectHealth } from "../infra-integrations/supabase/health"
import type { SupabaseProjectRow } from "../infra-integrations/supabase/model"
import { SUPABASE_BRAND, SUPABASE_NOT_CONFIGURED } from "../infra-integrations/supabase/connect"
import { integrationNotice } from "./kit/notice"
import { Message } from "./message"
import type { Model } from "./model"
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
type Drain = Project["logDrains"][number]

type Metrics = Model["supabaseCard"]["metrics"]

/** The project's metrics row, or `null` while the rows load, failed, or hold none for it. */
export const metricsRowOf = (metrics: Metrics, ref: string): SupabaseProjectRow | null =>
	Option.getOrNull(
		Option.flatMap(AsyncData.getData(metrics.data), (rows) =>
			Option.fromNullishOr(rows.find((row) => row.projectRef === ref)),
		),
	)

/** "metrics 23s · logs 41s": each switched-on source's freshness, or why it has none yet. */
export const lastDataLabel = (
	project: Project,
	metrics: Metrics,
	row: SupabaseProjectRow | null,
	nowMs: number,
): string => {
	if (lifecycleOf(project.status)._tag === "Paused") return "resumes when unpaused"
	const metricsPart = !project.metricsEnabled
		? []
		: row !== null && row.lastSeen !== ""
			? [`metrics ${formatRelativeShortFrom(toEpochMs(row.lastSeen), nowMs)}`]
			: AsyncData.isSuccess(metrics.data)
				? ["waiting for first scrape"]
				: AsyncData.isFailure(metrics.data)
					? ["metrics unavailable"]
					: []
	const logsPart = project.logDrainEnabled
		? [project.logDrainError === null ? "logs via drain" : "drain broken"]
		: !project.logsEnabled
			? []
			: project.logsLastPolledAt === null
				? ["logs waiting for first poll"]
				: [`logs ${formatRelativeShortFrom(project.logsLastPolledAt, nowMs)}`]
	const parts = [...metricsPart, ...logsPart]
	return parts.length > 0 ? parts.join(" · ") : project.metricsEnabled ? "" : "not collected"
}

const projectSwitch = (
	h: H,
	options: Readonly<{
		id: string
		isChecked: boolean
		isDisabled: boolean
		label: string
		onToggle: Message
	}>,
): Html =>
	h.span(
		[h.Class("flex w-20 shrink-0 justify-end")],
		switchControl(h, {
			id: options.id,
			inputId: `${options.id}-input`,
			isChecked: options.isChecked,
			isDisabled: options.isDisabled,
			ariaLabel: options.label,
			onToggle: options.onToggle,
		}),
	)

/** "soc2-archive (datadog, US1)"; a drain to Maple says so instead of naming our host. */
const drainLabel = (project: Project, drain: Drain): string =>
	drain.managedByMaple
		? project.logDrainEnabled
			? "Maple (managed here)"
			: "Maple (left over; turning the drain on replaces it)"
		: drain.toMaple
			? `${drain.name} (already sends to Maple)`
			: `${drain.name} (${drain.destination === null ? drain.backendType : `${drain.backendType}, ${drain.destination}`})`

/** A drain to Maple set up in Supabase: it already delivers, and a managed one would double it. */
const manualMapleDrain = (project: Project): Drain | undefined =>
	project.logDrains.find((drain) => drain.toMaple && !drain.managedByMaple)

const noteLine = (h: H, text: string, tone: "muted" | "error"): Html =>
	h.span(
		[
			h.Class(
				cn(
					"line-clamp-1 text-2xs [overflow-wrap:anywhere]",
					tone === "error" ? "text-severity-error" : "text-muted-foreground",
				),
			),
			h.Title(text),
		],
		[text],
	)

/** A project's lock and the values its switches show: a flip in flight shows its intended value. */
const switchState = (model: Model, project: Project) => {
	const pending = model.supabaseCard.pending.find((entry) => entry.ref === project.ref)
	const isLocked = lifecycleOf(project.status)._tag === "Paused" || pending !== undefined
	const metricsEnabled = pending?.kind === "metrics" ? pending.enabled : project.metricsEnabled
	const drainEnabled = pending?.kind === "drain" ? pending.enabled : project.logDrainEnabled
	// Turning a drain on stops polling server-side; show that while the write is in flight.
	const logsEnabled =
		pending?.kind === "logs" ? pending.enabled : drainEnabled ? false : project.logsEnabled
	return { isLocked, metricsEnabled, drainEnabled, logsEnabled }
}

/** The project's Metrics, Logs and Drain switches, shared by the card and the flow's Choose data. */
export const supabaseProjectSwitches = (h: H, model: Model, project: Project): ReadonlyArray<Html> => {
	const { isLocked, metricsEnabled, drainEnabled, logsEnabled } = switchState(model, project)
	const manual = manualMapleDrain(project)
	return [
		projectSwitch(h, {
			id: `supabase-metrics-${project.ref}`,
			isChecked: metricsEnabled,
			isDisabled: isLocked,
			label: `Collect metrics for ${project.name}`,
			onToggle: Message.ToggledSupabaseMetrics({ ref: project.ref, enabled: !metricsEnabled }),
		}),
		projectSwitch(h, {
			id: `supabase-logs-${project.ref}`,
			isChecked: logsEnabled,
			// A drain already delivers the project's logs; polling too would store them twice.
			// Polling already on can always be turned off.
			isDisabled: isLocked || (!logsEnabled && (drainEnabled || manual !== undefined)),
			label: `Collect logs for ${project.name}`,
			onToggle: Message.ToggledSupabaseLogs({ ref: project.ref, enabled: !logsEnabled }),
		}),
		projectSwitch(h, {
			id: `supabase-drain-${project.ref}`,
			isChecked: drainEnabled,
			isDisabled: isLocked || (manual !== undefined && !drainEnabled),
			label:
				manual === undefined
					? `Send ${project.name}'s logs through a Supabase log drain`
					: `${project.name} already sends logs to Maple through the drain ${manual.name}`,
			onToggle: Message.ToggledSupabaseLogDrain({ ref: project.ref, enabled: !drainEnabled }),
		}),
	]
}

/** The drains Supabase lists and the last drain or logs error, under the project's name. */
export const supabaseProjectNotes = (h: H, project: Project): ReadonlyArray<Html> => [
	...(project.logDrains.length > 0
		? [
				noteLine(
					h,
					`Drains: ${project.logDrains.map((drain) => drainLabel(project, drain)).join(", ")}`,
					"muted",
				),
			]
		: []),
	...(project.logDrainEnabled && project.logDrainError !== null
		? [noteLine(h, `Drain: ${project.logDrainError}`, "error")]
		: []),
	...(project.logsEnabled && project.logsError !== null
		? [noteLine(h, `Logs: ${project.logsError}`, "error")]
		: []),
]

const projectRow = (h: H, model: Model, project: Project): Html => {
	const row = metricsRowOf(model.supabaseCard.metrics, project.ref)
	const isPaused = lifecycleOf(project.status)._tag === "Paused"
	return h.div(
		[
			h.Key(project.ref),
			h.Class(
				cn(
					"flex items-center gap-4 border-b border-border-subtle px-4 py-2.5 text-sm last:border-0",
					isPaused && "opacity-60",
				),
			),
		],
		[
			h.span(
				[h.Class("flex w-0 min-w-48 flex-1 flex-col")],
				[
					h.span([h.Class("truncate"), h.Title(project.name)], [project.name]),
					h.span(
						[h.Class("truncate font-mono text-2xs text-muted-foreground")],
						[project.region === "" ? project.ref : `${project.ref} · ${project.region}`],
					),
					...supabaseProjectNotes(h, project),
				],
			),
			h.span(
				[h.Class("flex w-24 shrink-0")],
				[
					healthPill(
						h,
						projectHealth(project.status, row, isReadPending(model.supabaseCard.metrics.data)),
					),
				],
			),
			h.span(
				[h.Class("w-48 shrink-0 truncate font-mono text-2xs text-muted-foreground")],
				[lastDataLabel(project, model.supabaseCard.metrics, row, model.nowMs)],
			),
			...supabaseProjectSwitches(h, model, project),
		],
	)
}

const projectsTable = (h: H, model: Model, status: SupabaseIntegrationStatus): Html =>
	dataTable(
		h,
		{ ariaLabel: "Supabase projects" },
		[
			columnHead(h, { label: "Project", width: "w-0 min-w-48 flex-1" }),
			columnHead(h, { label: "Status", width: "w-24" }),
			columnHead(h, { label: "Last data", width: "w-48" }),
			columnHead(h, { label: "Metrics", width: "w-20", align: "right" }),
			columnHead(h, { label: "Logs", width: "w-20", align: "right" }),
			columnHead(h, { label: "Drain", width: "w-20", align: "right" }),
		],
		status.projects.length === 0
			? [dataTableEmpty(h, ["No projects in this organization yet. Sync after creating one."])]
			: status.projects.map((project) => projectRow(h, model, project)),
	)

export const SUPABASE_LOGS_NOTE =
	"Logs are pulled every minute through your grant and count toward ingest. A log drain has Supabase push them instead: it needs a Pro plan and Supabase bills it per drain."

const footer = (h: H): Html =>
	h.div(
		[
			h.Class(
				"flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 text-2xs text-muted-foreground",
			),
		],
		[
			h.p([], [SUPABASE_LOGS_NOTE]),
			h.a(
				[
					h.Href(hrefOf(AppRoute.InfraSupabase({ search: {} }))),
					h.Class("shrink-0 transition-colors hover:text-foreground"),
				],
				["View in Infrastructure"],
			),
		],
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
	return [
		status.organization === null ? "" : `${status.organization.name} · `,
		countLabel(status.projects.length, "project"),
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
			: button(
					h,
					{
						size: "sm",
						variant: "outline",
						isLoading: model.supabaseCard.isSyncing,
						attributes: [h.OnClick(Message.ClickedSupabaseSync())],
					},
					[icon(h, "ArrowRotateAnticlockwiseIcon"), "Sync now"],
				),
		disconnectButton(h, model),
	])

const byStatus = (h: H, model: Model, status: SupabaseIntegrationStatus, timeZone: string): Html => {
	if (!status.connected) return supabaseReconnect(h, status.configured)
	return connectedIntegrationCard(h, model, {
		integration: "supabase",
		brand: SUPABASE_BRAND,
		title: "Supabase",
		badge: statusBadge(h, status),
		summary: summaryLine(h, model, status, timeZone),
		notice: notice(h, status),
		actions: actions(h, model, status),
		table: projectsTable(h, model, status),
		actionsAtEnd: true,
		footer: footer(h),
	})
}

export const supabaseCard = (h: H, model: Model, timeZone: string): Html =>
	integrationStatusCard(h, model.statuses.supabase, {
		name: "supabase",
		failureTitle: "Couldn't load the Supabase integration",
		render: (status) => byStatus(h, model, status, timeZone),
	})

/** A source page whose organization was disconnected: the way back is the connect flow. */
const supabaseReconnect = (h: H, isConfigured: boolean): Html =>
	integrationNotice(h, {
		message: isConfigured ? "Supabase is not connected." : SUPABASE_NOT_CONFIGURED,
		action: isConfigured
			? linkButton(
					h,
					{
						size: "sm",
						href: hrefOf(AppRoute.SourcesNew({ search: { integration: "supabase" } })),
					},
					["Reconnect"],
				)
			: undefined,
	})
