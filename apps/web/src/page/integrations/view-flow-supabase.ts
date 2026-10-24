import type { SupabaseIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { formatRelativeShortFrom, toEpochMs } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { button } from "../../ui/button"
import { icon } from "../../ui/icon"
import { columnHead, dataTable, dataTableEmpty } from "../infra/kit/data-table"
import { SUPABASE_NOT_CONFIGURED } from "../infra-integrations/supabase/connect"
import { lifecycleOf } from "../infra-integrations/supabase/health"
import {
	type CheckRow,
	flowColumns,
	flowRail,
	foundChips,
	liveChecklist,
	savedBanner,
	statusRow,
	stepCard,
} from "../kit/connect-flow"
import { catalogEntry } from "./catalog"
import type { FlowStage } from "./flow"
import { isCollecting, reachableSupabase, supabaseOrgName, supabaseStatusOf } from "./flow-supabase"
import { Message } from "./message"
import type { Model } from "./model"
import {
	metricsRowOf,
	SUPABASE_LOGS_NOTE,
	supabaseProjectNotes,
	supabaseProjectSwitches,
} from "./view-supabase"

// Supabase in the connect flow: authorize an organization, switch on projects, watch the first data land.

type H = HtmlBuilder<Message>
type Project = SupabaseIntegrationStatus["projects"][number]

const DOCS_HREF = catalogEntry("supabase").docsUrl
const PROMETHEUS_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "prometheus" } }))

const readsRail = (h: H): Html =>
	flowRail(h, {
		eyebrow: "What Maple reads",
		items: [
			{ icon: "LayersIcon", title: "Projects", detail: "Names, regions and status, kept current" },
			{
				icon: "MicrochipIcon",
				title: "CPU, memory and disk",
				detail: "Scraped every minute from each project",
			},
			{
				icon: "DatabaseIcon",
				title: "Postgres health",
				detail: "Connections, commits, cache hit ratio, size",
			},
			{
				icon: "FileIcon",
				title: "Logs",
				detail: "Polled every minute, or through a log drain per project",
			},
		],
		trust: "Read-only. Maple only writes to Supabase when you turn on a log drain. Revoke any time in Supabase under Organization, OAuth Apps.",
		timeNote: "Takes about 1 minute",
		docs: DOCS_HREF === undefined ? null : { label: "Setup docs", href: DOCS_HREF },
	})

const isWaiting = (model: Model): boolean => model.connect.active?.provider === "supabase"

const muted = (h: H, text: string): Html => h.p([h.Class("text-sm text-muted-foreground")], [text])

/** What happens in the Supabase window, before it opens. */
const windowSteps = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-2 rounded-md bg-muted/40 p-4")],
		[
			h.span(
				[h.Class("font-mono text-[10px] uppercase tracking-wide text-muted-foreground")],
				["In the Supabase window"],
			),
			h.ul(
				[h.Class("flex flex-col gap-1.5 text-sm")],
				[
					h.li([], ["Pick the organization that owns your projects"]),
					h.li([], ["Review the read scopes: projects, analytics, database"]),
					h.li([], ["Click Authorize. This tab picks it up on its own"]),
				],
			),
		],
	)

const waitingBlock = (h: H): Html =>
	h.div(
		[h.Class("flex items-center gap-3 rounded-md bg-muted/40 p-4")],
		[
			icon(h, "ClockIcon", { size: 16, className: "shrink-0 text-muted-foreground" }),
			h.div(
				[h.Class("flex flex-col gap-0.5")],
				[
					h.span([h.Class("text-sm font-medium")], ["Waiting for you to approve in Supabase"]),
					h.span(
						[h.Class("text-xs text-muted-foreground")],
						["Pick an organization in that window, then click Authorize."],
					),
				],
			),
		],
	)

const authorizeButton = (h: H, model: Model, label: string, variant: "default" | "outline"): Html =>
	button(
		h,
		{
			variant,
			className: "w-fit",
			isDisabled: model.connect.isStarting || model.disconnect.isPending,
			isLoading: model.connect.isStarting,
			attributes: [h.OnClick(Message.ClickedConnect())],
		},
		[label, icon(h, "ExternalLinkIcon", { size: 14 })],
	)

const selfHostedLine = (h: H): Html =>
	h.div(
		[
			h.Class(
				"flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-xs text-muted-foreground",
			),
		],
		[
			h.span([], ["Self-hosted Supabase? Scrape its metrics endpoint as a Prometheus source."]),
			h.a(
				[
					h.Href(PROMETHEUS_HREF),
					h.Class("inline-flex items-center gap-1 text-foreground hover:underline"),
				],
				["Use Prometheus", icon(h, "ArrowRightIcon", { size: 12 })],
			),
		],
	)

const revokedNotice = (h: H, status: SupabaseIntegrationStatus): Html =>
	h.div(
		[h.Class("flex gap-3 rounded-lg border border-severity-warn/40 bg-card px-4 py-3"), h.Role("alert")],
		[
			icon(h, "CircleWarningIcon", { size: 14, className: "mt-0.5 shrink-0 text-severity-warn" }),
			h.div(
				[h.Class("flex flex-col gap-1")],
				[
					h.span([h.Class("text-sm font-medium")], ["Access revoked"]),
					h.span(
						[h.Class("text-xs text-muted-foreground")],
						[
							`Supabase no longer accepts Maple's access to ${supabaseOrgName(status)}, so discovery, metrics and log polling are paused. Log drains live in Supabase and keep sending.`,
						],
					),
				],
			),
		],
	)

const connectBody = (h: H, model: Model, status: SupabaseIntegrationStatus | null): ReadonlyArray<Html> => {
	if (status !== null && !status.configured) return [muted(h, SUPABASE_NOT_CONFIGURED)]
	if (isWaiting(model))
		return [
			muted(
				h,
				"The Supabase window is open. Approve access there and this page moves on by itself. Closing that window without approving cancels the attempt.",
			),
			waitingBlock(h),
			selfHostedLine(h),
		]
	const reached = reachableSupabase(status)
	if (reached !== null)
		return [
			muted(
				h,
				`Maple has access to ${supabaseOrgName(reached)}. To watch a different organization, authorize again and pick it in the Supabase window.`,
			),
			authorizeButton(h, model, "Authorize again", "outline"),
			selfHostedLine(h),
		]
	return [
		muted(
			h,
			"Supabase opens in a new window. Approve access for one organization there and come back. Nothing is collected yet: you pick projects and signals on the next step.",
		),
		windowSteps(h),
		authorizeButton(
			h,
			model,
			status?.revoked === true ? "Reconnect with Supabase" : "Continue with Supabase",
			"default",
		),
		selfHostedLine(h),
	]
}

const connectStatus = (h: H, model: Model, status: SupabaseIntegrationStatus | null): Html => {
	if (isWaiting(model))
		return statusRow(h, {
			tone: "working",
			text: "Waiting for Supabase. This step completes on its own as soon as you approve.",
		})
	const reached = reachableSupabase(status)
	if (reached !== null)
		return statusRow(
			h,
			{
				tone: "ok",
				text: `Connected to ${supabaseOrgName(reached)}. Maple can list its ${countLabel(reached.projects.length, "project")}.`,
			},
			reached.projects.length === 0
				? []
				: [
						foundChips(
							h,
							reached.projects.map((project) => ({ label: project.name })),
						),
					],
		)
	if (status?.revoked === true)
		return statusRow(h, {
			tone: "error",
			text: "Supabase rejected the saved grant. Reconnect to resume; this step completes on its own once you approve.",
		})
	return statusRow(h, {
		tone: "idle",
		text: "Not authorized yet. This step completes on its own when you approve in Supabase.",
	})
}

const connectStep = (h: H, model: Model): Html => {
	const status = supabaseStatusOf(model)
	return flowColumns(
		h,
		[
			...(status?.revoked === true ? [revokedNotice(h, status)] : []),
			stepCard(h, { icon: "SupabaseIcon", title: "Sign in with Supabase", note: "Read-only" }, [
				...connectBody(h, model, status),
			]),
			connectStatus(h, model, status),
		],
		readsRail(h),
	)
}

const chooseRow = (h: H, model: Model, project: Project): Html => {
	const isPaused = lifecycleOf(project.status)._tag === "Paused"
	return h.div(
		[
			h.Key(project.ref),
			h.Class(
				cn(
					"flex items-center gap-4 border-b border-border/40 px-4 py-2.5 text-sm last:border-0",
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
						[
							[project.region, project.ref, isPaused ? "paused" : ""]
								.filter((part) => part !== "")
								.join(" · "),
						],
					),
					...supabaseProjectNotes(h, project),
				],
			),
			...supabaseProjectSwitches(h, model, project),
		],
	)
}

const summaryRail = (h: H, status: SupabaseIntegrationStatus): Html => {
	const of = (count: number) => `${count} of ${status.projects.length}`
	const projects = status.projects
	return flowRail(h, {
		eyebrow: "You are about to collect",
		items: [
			{ icon: "LayersIcon", title: "Projects", detail: of(projects.filter(isCollecting).length) },
			{
				icon: "MicrochipIcon",
				title: "Metrics and Postgres health",
				detail: of(projects.filter((project) => project.metricsEnabled).length),
			},
			{
				icon: "FileIcon",
				title: "Logs, polled",
				detail: of(projects.filter((project) => project.logsEnabled).length),
			},
			{
				icon: "DatabaseIcon",
				title: "Log drains",
				detail: of(projects.filter((project) => project.logDrainEnabled).length),
			},
		],
		trust: "Change any of this later on the source page. Switches save as you flip them.",
		timeNote: "Metrics every minute",
		docs: DOCS_HREF === undefined ? null : { label: "Log drain docs", href: DOCS_HREF },
	})
}

const chooseStep = (h: H, model: Model): Html => {
	const status = reachableSupabase(supabaseStatusOf(model))
	if (status === null)
		return flowColumns(h, [statusRow(h, { tone: "idle", text: "Connect Supabase first." })], null)
	return flowColumns(
		h,
		[
			stepCard(h, { title: `Which projects in ${supabaseOrgName(status)} should Maple watch?` }, [
				muted(h, "Switches are per project and per signal, and save as you flip them."),
				dataTable(
					h,
					{ ariaLabel: "Supabase projects" },
					[
						columnHead(h, { label: "Project", width: "w-0 min-w-48 flex-1" }),
						columnHead(h, { label: "Metrics", width: "w-20", align: "right" }),
						columnHead(h, { label: "Logs", width: "w-20", align: "right" }),
						columnHead(h, { label: "Drain", width: "w-20", align: "right" }),
					],
					status.projects.length === 0
						? [
								dataTableEmpty(h, [
									"No projects in this organization yet. Create one in Supabase.",
								]),
							]
						: status.projects.map((project) => chooseRow(h, model, project)),
				),
				h.p([h.Class("text-xs text-muted-foreground")], [SUPABASE_LOGS_NOTE]),
			]),
		],
		summaryRail(h, status),
	)
}

const showsUpRail = (h: H): Html =>
	flowRail(h, {
		eyebrow: "Where it shows up",
		items: [
			{
				icon: "ServerIcon",
				title: "Infrastructure, Supabase",
				detail: "One row per project with its health",
			},
			{
				icon: "DatabaseIcon",
				title: "Project pages",
				detail: "Resources, Postgres, API traffic and logs",
			},
			{ icon: "GearIcon", title: "Source page", detail: "Switches, Sync now, Disconnect" },
		],
		timeNote: "First metrics usually within 2 minutes",
		docs: DOCS_HREF === undefined ? null : { label: "Docs", href: DOCS_HREF },
	})

const metricsCheck = (model: Model, projects: ReadonlyArray<Project>): CheckRow | null => {
	const watched = projects.filter((project) => project.metricsEnabled)
	if (watched.length === 0) return null
	const data = model.supabaseCard.metrics.data
	if (AsyncData.isFailure(data))
		return { state: "failed", title: "First metrics", detail: "Failed to read the last hour's metrics." }
	const seen = watched.flatMap((project) => {
		const row = metricsRowOf(model.supabaseCard.metrics, project.ref)
		return row === null || row.lastSeen === "" ? [] : [toEpochMs(row.lastSeen)]
	})
	const latest = Math.max(0, ...seen)
	const reporting = seen
	return reporting.length === watched.length
		? {
				state: "done",
				title: "First metrics",
				detail: `${reporting.length} of ${watched.length} projects reporting CPU, memory, disk and Postgres`,
				meta: latest > 0 ? formatRelativeShortFrom(latest, model.nowMs) : null,
			}
		: {
				state: "working",
				title: "First metrics",
				detail: `${reporting.length} of ${watched.length} projects reporting · usually under 2 minutes`,
			}
}

const logsCheck = (model: Model, projects: ReadonlyArray<Project>): CheckRow | null => {
	const polled = projects.filter((project) => project.logsEnabled)
	const drained = projects.filter((project) => project.logDrainEnabled)
	if (polled.length === 0 && drained.length === 0) return null
	const broken = [
		...polled.flatMap((project) =>
			project.logsError === null ? [] : [`${project.name}: ${project.logsError}`],
		),
		...drained.flatMap((project) =>
			project.logDrainError === null ? [] : [`${project.name} drain: ${project.logDrainError}`],
		),
	]
	if (broken.length > 0) return { state: "failed", title: "First logs", detail: broken.join(" · ") }
	const waiting = polled.filter((project) => project.logsLastPolledAt === null)
	const latest = polled.reduce((max, project) => Math.max(max, project.logsLastPolledAt ?? 0), 0)
	if (waiting.length > 0)
		return {
			state: "working",
			title: "First logs",
			detail: `${polled.length - waiting.length} of ${polled.length} projects polled · polling runs every minute`,
		}
	return {
		state: "done",
		title: "Logs flowing",
		detail: [
			polled.length > 0 ? `${countLabel(polled.length, "project")} polled every minute` : "",
			drained.length > 0
				? `drain on ${drained.map((project) => project.name).join(", ")}, sending as lines are written`
				: "",
		]
			.filter((part) => part !== "")
			.join(" · "),
		meta: latest > 0 ? formatRelativeShortFrom(latest, model.nowMs) : null,
	}
}

const drainCheck = (drains: ReadonlyArray<Project>): ReadonlyArray<CheckRow> => {
	if (drains.length === 0) return []
	const broken = drains.flatMap((project) =>
		project.logDrainError === null ? [] : [`${project.name}: ${project.logDrainError}`],
	)
	return [
		broken.length > 0
			? { state: "failed", title: "Log drain", detail: broken.join(" · ") }
			: {
					state: "done",
					title: `Log drain created on ${drains.map((project) => project.name).join(", ")}`,
					detail: "Visible in Supabase under Project Settings, Log Drains",
				},
	]
}

const liveRows = (model: Model, status: SupabaseIntegrationStatus): ReadonlyArray<CheckRow> => {
	const collecting = status.projects.filter(isCollecting)
	const drains = collecting.filter((project) => project.logDrainEnabled)
	return [
		status.revoked
			? {
					state: "failed",
					title: "Access revoked",
					detail: "Supabase no longer accepts Maple's access. Go back to Connect and reconnect.",
				}
			: {
					state: "done",
					title: "Access works",
					detail: `Maple can read ${supabaseOrgName(status)} with the granted scopes`,
				},
		status.lastDiscoveryError !== null
			? { state: "failed", title: "Finding projects", detail: status.lastDiscoveryError }
			: {
					state: "done",
					title: "Projects found",
					detail: `${countLabel(status.projects.length, "project")}, ${collecting.length} collecting`,
				},
		...drainCheck(drains),
		...[metricsCheck(model, collecting), logsCheck(model, collecting)].filter(
			(row): row is CheckRow => row !== null,
		),
	]
}

const liveStep = (h: H, model: Model): Html => {
	const status = supabaseStatusOf(model)
	return flowColumns(
		h,
		[
			savedBanner(
				h,
				"Saved as a source. Safe to leave; collection keeps running.",
				"Nothing to apply in Supabase",
			),
			liveChecklist(h, {
				rows:
					status === null || !status.connected
						? [{ state: "waiting", title: "Waiting for Supabase's status" }]
						: liveRows(model, status),
			}),
		],
		showsUpRail(h),
	)
}

export const supabaseFlowView = (h: H, model: Model, stage: FlowStage): Html =>
	stage === "live" ? liveStep(h, model) : stage === "choose" ? chooseStep(h, model) : connectStep(h, model)
