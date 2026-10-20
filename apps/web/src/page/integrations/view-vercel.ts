import { formatCost } from "@maple/agent-sessions"
import type {
	VercelDrainStatus,
	VercelInfraProject,
	VercelIntegrationStatus,
	VercelProjectStatus,
} from "@maple/domain/http"
import { countLabel, formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	deploymentStateLabel,
	deploymentTone,
	samplingLabel,
	scopeLabel,
	signalsLabel,
	vercelHealth,
	vercelIssues,
	type VercelIssue,
} from "../../components/integrations/vercel-model"
import { AppRoute, hrefOf } from "../../route"
import { alert, alertAction, alertDescription, alertTitle } from "../../ui/alert"
import { button, linkButton } from "../../ui/button"
import { confirmDialog } from "../../ui/confirm-dialog"
import { badge } from "../../ui/display"
import { errorState } from "../../ui/error-state"
import { icon } from "../../ui/icon"
import { item, itemContent, itemMedia } from "../../ui/item"
import { panel, panelHeader } from "../../ui/panel"
import { skeleton } from "../../ui/skeleton"
import { statusDot } from "../../ui/status-dot"
import { truncatedText } from "../../ui/truncated-text"
import { columnHead, dataTable, dataTableEmpty, ROW_LINK_CLASS } from "../infra/kit/data-table"
import {
	integrationEmpty,
	integrationEmptyCard,
	integrationEmptyFeatures,
	integrationEmptyFooter,
	integrationEmptyHint,
	integrationEmptyMedia,
	integrationIconPlate,
} from "../infra-integrations/kit/integration-empty"
import { relativeTime } from "../kit/relative-time"
import { statRail, statRailItem, statRailLoading } from "../kit/stat-rail"
import { VERCEL_ACCENT } from "./catalog"
import { Message } from "./message"
import type { Model } from "./model"
import { vercelConfigure, vercelCostNote } from "./view-vercel-configure"

// `VercelIntegrationCard`: not connected, or a connected team's issues, last 24 hours, projects and drains.

type H = HtmlBuilder<Message>
type Tone = "ok" | "warn" | "crit" | "neutral"

const BRAND = { icon: "VercelIcon", accent: VERCEL_ACCENT, iconClassName: "text-foreground" } as const

const DRAIN_LABEL = {
	enabled: { label: "Enabled", tone: "ok" },
	disabled: { label: "Disabled", tone: "warn" },
	errored: { label: "Failing", tone: "crit" },
	missing: { label: "Deleted on Vercel", tone: "crit" },
	unknown: { label: "Not checked yet", tone: "neutral" },
} as const satisfies Record<VercelDrainStatus["status"], { label: string; tone: Tone }>

const HEALTH_BADGE = {
	healthy: { label: "Connected", variant: "ok" },
	pending: { label: "First sync pending", variant: "outline" },
	attention: { label: "Needs attention", variant: "warn" },
} as const

/** The drains Maple installed, as Vercel lists them: only the enabled signals have one. */
export const drainNamesOf = (status: Pick<VercelIntegrationStatus, "logsEnabled" | "tracesEnabled">) => [
	...(status.logsEnabled ? ["Maple logs"] : []),
	...(status.tracesEnabled ? ["Maple traces"] : []),
]

const mono = (h: H, text: string): Html => h.span([h.Class("font-mono text-foreground")], [text])

// NOT CONNECTED

const FEATURES = [
	{
		label: "Requests",
		title: "Traffic, errors and cache",
		description: "Every request, function and edge log, with status, path and cache result per project.",
	},
	{
		label: "AI Gateway",
		title: "Spend by model and project",
		description: "Each gateway request with its model, tokens, cost and latency, also in Agent Sessions.",
	},
	{
		label: "Deployments",
		title: "Next to your traces",
		description: "Production deployments per project, and deployment traces from @vercel/otel.",
	},
]

const notConnected = (h: H, model: Model): Html =>
	integrationEmpty(h, [
		integrationEmptyFeatures(h, FEATURES),
		integrationEmptyCard(h, [
			integrationEmptyMedia(h, BRAND),
			...(model.isAdmin
				? [
						integrationEmptyHint(h, [
							"Paste a Vercel token. Maple creates a logs drain and a traces drain on the team you pick.",
						]),
						button(h, { attributes: [h.OnClick(Message.ClickedVercelConfigure({ target: "connect" }))] }, [
							icon(h, "VercelIcon"),
							"Connect Vercel",
						]),
						integrationEmptyFooter(h, [
							"Needs Vercel Pro or Enterprise · Vercel bills drains by volume · sampling lowers it",
						]),
					]
				: [integrationEmptyHint(h, ["A Maple organization admin connects Vercel with a team token."])]),
		]),
	])

// CONNECTED

/** The team, what it forwards and when it was checked, with the actions that change the connection. */
const summary = (h: H, model: Model, status: VercelIntegrationStatus, timeZone: string): Html => {
	const health = HEALTH_BADGE[vercelHealth(status)]
	const card = model.vercelCard
	return item(h, { variant: "card", className: "items-start gap-4 p-4" }, [
		itemMedia(h, {}, [integrationIconPlate(h, BRAND)]),
		itemContent(
			h,
			[
				h.div(
					[h.Class("flex flex-wrap items-center gap-2")],
					[
						h.h3([h.Class("text-sm font-semibold")], [status.team?.name ?? "Vercel"]),
						...(status.team === null
							? []
							: [h.span([h.Class("font-mono text-xs text-muted-foreground")], [status.team.slug])]),
						status.authFailed
							? badge(h, { variant: "crit" }, ["Token rejected"])
							: badge(h, { variant: health.variant }, [health.label]),
					],
				),
				h.p(
					[h.Class("text-xs text-muted-foreground")],
					[
						`${signalsLabel(status)} · ${scopeLabel(status)} · ${samplingLabel(status.samplingRate)}`,
						...(status.lastSuccessAt === null
							? [" · waiting for the first check"]
							: [
									" · ",
									relativeTime(h, {
										value: status.lastSuccessAt,
										nowMs: model.nowMs,
										timeZone,
										prefix: "checked",
									}),
								]),
					],
				),
				h.div(
					[h.Class("flex flex-wrap items-center gap-2")],
					[
						linkButton(h, { size: "sm", href: hrefOf(AppRoute.InfraVercel({ search: {} })) }, [
							"View metrics",
						]),
						...(model.isAdmin
							? [
									button(
										h,
										{
											size: "sm",
											variant: "outline",
											isLoading: card.isSyncing,
											attributes: [h.OnClick(Message.ClickedVercelSync())],
										},
										["Sync now"],
									),
									button(
										h,
										{
											size: "sm",
											variant: "outline",
											attributes: [h.OnClick(Message.ClickedVercelConfigure({ target: "configure" }))],
										},
										["Configure"],
									),
									button(
										h,
										{
											size: "sm",
											variant: "destructive-outline",
											isLoading: model.disconnect.isPending,
											attributes: [h.OnClick(Message.ClickedDisconnect())],
										},
										["Disconnect"],
									),
								]
							: [
									h.span(
										[h.Class("text-xs text-muted-foreground")],
										["Only Maple organization admins can configure or disconnect Vercel."],
									),
								]),
					],
				),
			],
			"gap-2",
		),
	])
}

const issueAlert = (h: H, model: Model, issue: VercelIssue): Html =>
	alert(h, { variant: issue.tone }, [
		icon(h, "CircleWarningIcon"),
		alertTitle(h, [issue.title]),
		alertDescription(h, [
			h.span([], [issue.description]),
			...(issue.vercelError === null
				? []
				: [h.span([h.Class("font-mono text-2xs [overflow-wrap:anywhere]")], ["Vercel: ", issue.vercelError])]),
		]),
		...(model.isAdmin
			? [
					alertAction(h, [
						issue.fix === "token"
							? button(
									h,
									{
										size: "sm",
										attributes: [h.OnClick(Message.ClickedVercelConfigure({ target: "token" }))],
									},
									["Paste a new token"],
								)
							: button(
									h,
									{
										size: "sm",
										variant: "outline",
										isLoading: model.vercelCard.isReapplying,
										attributes: [h.OnClick(Message.ClickedVercelReapply())],
									},
									["Re-apply drains"],
								),
					]),
				]
			: []),
	])

/** A read's rows: `null` while loading, `"failed"` when it failed (`readOf`). */
const readOf = <A, E, B>(data: AsyncData.AsyncData<A, E>, value: (a: A) => B): B | null | "failed" =>
	AsyncData.match(data, {
		onIdle: () => null,
		onLoading: () => null,
		onFailure: () => "failed" as const,
		onStale: () => "failed" as const,
		onRefreshing: value,
		onSuccess: value,
	})

const failureOf = <A, E>(data: AsyncData.AsyncData<A, E>): E | null =>
	AsyncData.isFailure(data) ? data.error : null

/** The first failed read's cause, `null` when none failed. */
const usageFailure = (model: Model) => {
	const card = model.vercelCard
	return failureOf(card.projects.data) ?? failureOf(card.timeseries.data) ?? failureOf(card.gateway.data)
}

/** The 24h readout: traffic, failures and AI Gateway spend. */
const quickMetrics = (h: H, model: Model, status: VercelIntegrationStatus): Html => {
	const card = model.vercelCard
	const rows = readOf(card.projects.data, (response) => response.projects)
	const buckets = readOf(card.timeseries.data, (response) => response.buckets)
	const gateway = readOf(card.gateway.data, (response) => response)
	const failure = usageFailure(model)
	if (failure !== null)
		return errorState(h, {
			failure,
			title: "Failed to load the last 24 hours",
			onRetry: Message.ClickedVercelRetryUsage(),
			variant: "row",
		})
	if (rows === null || rows === "failed") return statRailLoading(h, 3, 3)
	const spark = buckets === null || buckets === "failed" ? undefined : buckets
	const usage = gateway === "failed" ? null : gateway
	const requests = rows.reduce((sum, row) => sum + row.requests, 0)
	const failed = rows.reduce((sum, row) => sum + row.requests5xx, 0)
	const errorLogs = rows.reduce((sum, row) => sum + row.errorLogs, 0)
	return statRail(h, { columns: 3 }, [
		statRailItem(h, {
			eyebrow: "Requests · 24h",
			value: formatNumber(requests),
			spark: spark?.map((bucket) => bucket.requests),
			sparkColor: "var(--foreground)",
			subline: status.logsEnabled
				? `${countLabel(rows.length, "project")} sending logs`
				: "Logs are off. Turn them on in Configure.",
		}),
		statRailItem(h, {
			eyebrow: "Server errors · 24h",
			value: formatNumber(failed),
			tone: failed > 0 ? "crit" : undefined,
			spark: spark?.map((bucket) => bucket.requests5xx),
			subline: `${requests > 0 ? formatErrorRate(failed / requests) : "0%"} of requests · ${formatNumber(errorLogs)} error logs`,
		}),
		statRailItem(h, {
			eyebrow: "AI Gateway · 24h",
			value: usage === null ? "—" : formatCost(usage.summary.costUsd),
			spark: usage?.timeseries.map((bucket) => bucket.costUsd),
			sparkColor: "var(--foreground)",
			subline: !status.tracesEnabled
				? "Traces are off. AI Gateway usage needs them."
				: usage === null || usage.summary.requests === 0
					? "No AI Gateway requests yet"
					: `${formatNumber(usage.summary.requests)} requests · ${formatNumber(usage.summary.inputTokens + usage.summary.outputTokens)} tokens`,
			action: h.a(
				[
					h.Href(hrefOf(AppRoute.InfraVercel({ search: { view: "aiGateway" } }))),
					h.Class(
						"inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground hover:text-foreground",
					),
				],
				["Open", icon(h, "ArrowRightIcon", { size: 11 })],
			),
		}),
	])
}

const productionCell = (h: H, model: Model, project: VercelProjectStatus, timeZone: string): Html => {
	const deployment = project.productionDeployment
	if (deployment === null) return h.span([h.Class("text-muted-foreground")], ["No production deploy"])
	return h.span(
		[h.Class("flex min-w-0 items-center gap-1.5")],
		[
			statusDot(h, { tone: deploymentTone(deployment.state) }),
			h.span([h.Class("shrink-0")], [deploymentStateLabel(deployment.state)]),
			relativeTime(h, {
				value: deployment.createdAt,
				nowMs: model.nowMs,
				timeZone,
				variant: "short",
				tooltip: "title",
				className: "shrink-0 text-muted-foreground",
			}),
			...(deployment.branch === null
				? []
				: [truncatedText(h, { text: deployment.branch, mono: true, className: "text-xs text-muted-foreground" })]),
		],
	)
}

/** Forwarded first, then by traffic: the projects Maple watches lead. */
const projectsPanel = (h: H, model: Model, status: VercelIntegrationStatus, timeZone: string): Html => {
	const card = model.vercelCard
	const rows = readOf(card.projects.data, (response) => response.projects)
	const byProject = Array.isArray(rows)
		? new Map<string, VercelInfraProject>(rows.map((row) => [row.projectId, row]))
		: null
	const requestsOf = (id: string) => byProject?.get(id)?.requests ?? 0
	const projects = status.projects.toSorted(
		(a, b) =>
			Number(b.forwarded) - Number(a.forwarded) ||
			requestsOf(b.id) - requestsOf(a.id) ||
			a.name.localeCompare(b.name),
	)
	return panel(h, { className: "min-w-0 flex-1 overflow-hidden" }, [
		panelHeader(h, { title: `Projects (${status.projects.length})` }),
		dataTable(
			h,
			{ ariaLabel: "Vercel projects", className: "border-y-0", maxHeight: "420px" },
			[
				columnHead(h, { label: "Project", width: "w-0 min-w-44 flex-1" }),
				columnHead(h, { label: "Production", width: "w-64", hidden: "hidden md:flex" }),
				columnHead(h, { label: "Requests · 24h", width: "w-28", align: "right" }),
				columnHead(h, { label: "5xx", width: "w-16", align: "right" }),
			],
			projects.length === 0
				? [dataTableEmpty(h, ["Projects appear after the first sync, within a few minutes."])]
				: projects.map((project) => {
						const row = byProject?.get(project.id)
						const errors = row?.requests5xx ?? 0
						return h.a(
							[
								h.Key(project.id),
								h.Href(hrefOf(AppRoute.InfraVercelProject({ projectId: project.id, search: {} }))),
								h.Class(cn(ROW_LINK_CLASS, "py-2.5 text-sm")),
							],
							[
								h.span(
									[h.Class("flex w-0 min-w-44 flex-1 items-center gap-2")],
									[
										truncatedText(h, { text: project.name, className: "font-medium" }),
										...(project.framework === null
											? []
											: [badge(h, { variant: "meta", size: "xs" }, [project.framework])]),
										...(project.forwarded
											? []
											: [badge(h, { variant: "outline", size: "xs" }, ["Not forwarded"])]),
									],
								),
								h.span(
									[h.Class("hidden w-64 shrink-0 text-xs md:flex")],
									[productionCell(h, model, project, timeZone)],
								),
								h.span(
									[h.Class("w-28 shrink-0 text-right tabular-nums")],
									[
										rows === "failed"
											? h.span([h.Class("text-muted-foreground")], ["—"])
											: byProject === null
												? skeleton(h, "ml-auto h-4 w-12")
												: formatNumber(row?.requests ?? 0),
									],
								),
								h.span(
									[
										h.Class(
											cn(
												"w-16 shrink-0 text-right tabular-nums",
												errors > 0 ? "text-severity-error" : "text-muted-foreground",
											),
										),
									],
									[byProject === null ? "" : formatNumber(errors)],
								),
							],
						)
					}),
		),
	])
}

const drainRow = (h: H, name: string, enabled: boolean, drain: VercelDrainStatus | null): Html => {
	const state: { readonly label: string; readonly tone: Tone } = !enabled
		? { label: "Off", tone: "neutral" }
		: drain === null
			? { label: "Missing", tone: "crit" }
			: DRAIN_LABEL[drain.status]
	return h.li(
		[h.Class("flex items-center gap-3 px-4 py-2.5")],
		[
			statusDot(h, { tone: state.tone }),
			h.span(
				[h.Class("flex min-w-0 flex-1 flex-col")],
				[
					h.span([h.Class("font-mono text-xs text-foreground")], [name]),
					...(enabled && drain !== null && drain.id !== null
						? [truncatedText(h, { text: drain.id, mono: true, className: "text-2xs text-muted-foreground" })]
						: []),
				],
			),
			h.span([h.Class("shrink-0 text-xs text-muted-foreground")], [state.label]),
		],
	)
}

/** What Maple installed on the team, and what it forwards. */
const drainsPanel = (h: H, status: VercelIntegrationStatus): Html => {
	const fact = (term: string, value: ReadonlyArray<Html | string>): ReadonlyArray<Html> => [
		h.dt([h.Class("text-muted-foreground")], [term]),
		h.dd([h.Class("truncate text-right")], value),
	]
	return h.div(
		[h.Class("flex flex-col gap-4 lg:w-80 lg:shrink-0")],
		[
			panel(h, { className: "overflow-hidden" }, [
				panelHeader(h, { title: "Drains on Vercel" }),
				h.ul(
					[h.Class("divide-y divide-border/60 border-b border-border/60")],
					[
						drainRow(h, "Maple logs", status.logsEnabled, status.drains.logs),
						drainRow(h, "Maple traces", status.tracesEnabled, status.drains.traces),
					],
				),
				h.dl(
					[h.Class("grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-4 py-3 text-xs")],
					[
						...fact("Sends", [signalsLabel(status)]),
						...fact("Projects", [scopeLabel(status)]),
						...fact("Sampling", [samplingLabel(status.samplingRate)]),
					],
				),
			]),
			vercelCostNote(h),
		],
	)
}

/** `ConfirmDialog` before disconnecting: what goes on Vercel at once, and what stays in Maple. */
const disconnectDialog = (h: H, model: Model, status: VercelIntegrationStatus): Html => {
	const names = drainNamesOf(status)
	const team = status.team?.name ?? "the team"
	const drains =
		names.length > 1
			? ["the ", mono(h, names[0] ?? ""), " and ", mono(h, names[1] ?? ""), " drains"]
			: ["the ", mono(h, names[0] ?? ""), " drain"]
	const fact = (term: string, detail: ReadonlyArray<Html | string>): Html =>
		h.div(
			[],
			[h.dt([h.Class("font-medium")], [term]), h.dd([h.Class("text-pretty text-muted-foreground")], detail)],
		)
	return confirmDialog(h, {
		slotId: "integration-disconnect",
		model: model.disconnect.dialog,
		toParentMessage: (message) => Message.GotDisconnectDialogMessage({ message }),
		title: "Disconnect Vercel?",
		confirmLabel: "Disconnect",
		onConfirm: Message.ConfirmedDisconnect(),
		isPending: model.disconnect.isPending,
		children: [
			h.dl(
				[h.Class("flex flex-col gap-3 pb-3 text-sm")],
				[
					fact("On Vercel, right away", ["Deletes ", ...drains, " on ", team, "."]),
					fact("In Maple", ["Removes the token. Logs and traces already in Maple stay until retention ends."]),
				],
			),
		],
	})
}

const connectedView = (h: H, model: Model, status: VercelIntegrationStatus, timeZone: string): Html =>
	h.div(
		[h.Class("flex flex-col gap-4")],
		[
			summary(h, model, status, timeZone),
			...vercelIssues(status).map((issue) => issueAlert(h, model, issue)),
			quickMetrics(h, model, status),
			h.div(
				[h.Class("flex flex-col gap-4 lg:flex-row lg:items-start")],
				[projectsPanel(h, model, status, timeZone), drainsPanel(h, status)],
			),
			disconnectDialog(h, model, status),
		],
	)

const byStatus = (h: H, model: Model, status: VercelIntegrationStatus, timeZone: string): Html =>
	status.connected ? connectedView(h, model, status, timeZone) : notConnected(h, model)

/** The card, and the configuration dialog it opens (connect, Configure, a new token). */
export const vercelCard = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => [
	AsyncData.match(model.statuses.vercel.data, {
		onIdle: () => skeleton(h, "h-40 w-full rounded-md"),
		onLoading: () => skeleton(h, "h-40 w-full rounded-md"),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load the Vercel integration",
				onRetry: Message.ClickedRetryStatus({ name: "vercel" }),
			}),
		onStale: ({ data }) => byStatus(h, model, data, timeZone),
		onRefreshing: (data) => byStatus(h, model, data, timeZone),
		onSuccess: (data) => byStatus(h, model, data, timeZone),
	}),
	...vercelConfigure(h, model),
]
