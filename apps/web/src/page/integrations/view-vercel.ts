import { formatCost } from "@maple/agent-sessions"
import type {
	VercelDrainStatus,
	VercelInfraProject,
	VercelIntegrationStatus,
	VercelProjectStatus,
} from "@maple/domain/http"
import { countLabel, formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, Order, String as Str } from "effect"
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
import { alert, alertAction, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button, linkButton } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { badge } from "@maple/views/ui/display"
import { errorState } from "@maple/views/ui/error-state"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { item, itemContent, itemMedia } from "@maple/views/ui/item"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { dividedList } from "@maple/views/ui/rule"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack, vstackClass } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { textLink } from "@maple/views/ui/text-link"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { typography, typographyClass } from "@maple/views/ui/typography"
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
import { canManage, type Model } from "./model"
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

const mono = (h: H, text: string): Html => typography(h, { tone: "foreground", mono: true }, [text])

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
			...(canManage(model)
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
				hstack(
					h,
					{ gap: "2", wrap: true },
					[
						heading(h, { level: 3, variant: "section" }, [status.team?.name ?? "Vercel"]),
						...(status.team === null
							? []
							: [typography(h, { size: "xs", tone: "muted", mono: true }, [status.team.slug])]),
						status.authFailed
							? badge(h, { variant: "crit" }, ["Token rejected"])
							: badge(h, { variant: health.variant }, [health.label]),
					],
				),
				typography(
					h,
					{ as: "p", size: "xs", tone: "muted" },
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
				hstack(
					h,
					{ gap: "2", wrap: true },
					[
						linkButton(h, { size: "sm", href: hrefOf(AppRoute.InfraVercel({ search: {} })) }, [
							"View metrics",
						]),
						...(canManage(model)
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
									typography(
										h,
										{ size: "xs", tone: "muted" },
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
		...(canManage(model)
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
			title: "Couldn't load the last 24 hours",
			onRetry: Message.ClickedVercelRetryUsage(),
			variant: "row",
		})
	if (rows === null || rows === "failed") return statRailLoading(h, 3, 3)
	const spark = buckets === null || buckets === "failed" ? undefined : buckets
	const usage = gateway === "failed" ? null : gateway
	const requests = Arr.reduce(rows, 0, (sum, row) => sum + row.requests)
	const failed = Arr.reduce(rows, 0, (sum, row) => sum + row.requests5xx)
	const errorLogs = Arr.reduce(rows, 0, (sum, row) => sum + row.errorLogs)
	return statRail(h, { columns: 3 }, [
		statRailItem(h, {
			eyebrow: "Requests · 24h",
			value: formatNumber(requests),
			spark: spark === undefined ? undefined : Arr.map(spark, (bucket) => bucket.requests),
			sparkColor: "var(--foreground)",
			subline: status.logsEnabled
				? `${countLabel(rows.length, "project")} sending logs`
				: "Logs are off. Turn them on in Configure.",
		}),
		statRailItem(h, {
			eyebrow: "Server errors · 24h",
			value: formatNumber(failed),
			tone: failed > 0 ? "crit" : undefined,
			spark: spark === undefined ? undefined : Arr.map(spark, (bucket) => bucket.requests5xx),
			subline: `${requests > 0 ? formatErrorRate(failed / requests) : "0%"} of requests · ${formatNumber(errorLogs)} error logs`,
		}),
		statRailItem(h, {
			eyebrow: "AI Gateway · 24h",
			value: usage === null ? "—" : formatCost(usage.summary.costUsd),
			spark: usage === null ? undefined : Arr.map(usage.timeseries, (bucket) => bucket.costUsd),
			sparkColor: "var(--foreground)",
			subline: !status.tracesEnabled
				? "Traces are off. AI Gateway usage needs them."
				: usage === null || usage.summary.requests === 0
					? "No AI Gateway requests yet"
					: `${formatNumber(usage.summary.requests)} requests · ${formatNumber(usage.summary.inputTokens + usage.summary.outputTokens)} tokens`,
			action: typography(h, { size: "2xs", className: "shrink-0" }, [
				textLink(
					h,
					{ href: hrefOf(AppRoute.InfraVercel({ search: { view: "aiGateway" } })), tone: "muted" },
					["Open", icon(h, "ArrowRightIcon", { size: 11 })],
				),
			]),
		}),
	])
}

const productionCell = (h: H, model: Model, project: VercelProjectStatus, timeZone: string): Html => {
	const deployment = project.productionDeployment
	if (deployment === null) return typography(h, { tone: "muted" }, ["No production deploy"])
	return hstack(
		h,
		{ as: "span", gap: "1.5", shrink: true },
		[
			statusDot(h, { tone: deploymentTone(deployment.state) }),
			h.span([h.Class("shrink-0")], [deploymentStateLabel(deployment.state)]),
			relativeTime(h, {
				value: deployment.createdAt,
				nowMs: model.nowMs,
				timeZone,
				variant: "short",
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
	const byProject =
		rows === null || rows === "failed"
			? null
			: new Map<string, VercelInfraProject>(Arr.map(rows, (row) => [row.projectId, row] as const))
	const requestsOf = (id: string) => byProject?.get(id)?.requests ?? 0
	const projects = Arr.sort(
		status.projects,
		Order.combineAll([
			Order.mapInput(Order.flip(Order.Boolean), (project: VercelProjectStatus) => project.forwarded),
			Order.mapInput(Order.flip(Order.Number), (project: VercelProjectStatus) => requestsOf(project.id)),
			Order.make((a: VercelProjectStatus, b: VercelProjectStatus) => Str.localeCompare(b.name)(a.name)),
		]),
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
				? [dataTableEmpty(h, ["Projects appear after the first sync, within a few minutes"])]
				: Arr.map(projects, (project) => {
						const row = byProject?.get(project.id)
						const errors = row?.requests5xx ?? 0
						return h.a(
							[
								h.Key(project.id),
								h.Href(hrefOf(AppRoute.InfraVercelProject({ projectId: project.id, search: {} }))),
								h.Class(cn(ROW_LINK_CLASS, "py-2.5 text-sm")),
							],
							[
								hstack(
									h,
									{ as: "span", gap: "2", grow: true, className: "w-0 min-w-44" },
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
											? typography(h, { tone: "muted" }, ["—"])
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
	return hstack(h, { as: "li", gap: "3", className: "px-4 py-2.5" }, [
		statusDot(h, { tone: state.tone }),
		vstack(
			h,
			{ as: "span", shrink: true, grow: true },
			[
				typography(h, { size: "xs", tone: "foreground", mono: true }, [name]),
				...(enabled && drain !== null && drain.id !== null
					? [
							truncatedText(h, {
								text: drain.id,
								mono: true,
								className: typographyClass({ size: "2xs", tone: "muted" }),
							}),
						]
					: []),
			],
		),
		typography(h, { size: "xs", tone: "muted", className: "shrink-0" }, [state.label]),
	])
}

/** What Maple installed on the team, and what it forwards. */
const drainsPanel = (h: H, status: VercelIntegrationStatus): Html => {
	const fact = (term: string, value: ReadonlyArray<Html | string>): ReadonlyArray<Html> => [
		h.dt([h.Class("text-muted-foreground")], [term]),
		h.dd([h.Class("truncate text-right")], value),
	]
	return vstack(
		h,
		{ gap: "4", className: "lg:w-80 lg:shrink-0" },
		[
			panel(h, { className: "overflow-hidden" }, [
				panelHeader(h, { title: "Drains on Vercel" }),
				dividedList(
					h,
					{ as: "ul", bordered: false, className: "border-b border-border-subtle" },
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
				[h.Class(vstackClass({ gap: "3", className: "pb-3 text-sm" }))],
				[
					fact("On Vercel, right away", ["Deletes ", ...drains, " on ", team, "."]),
					fact("In Maple", ["Removes the token. Logs and traces already in Maple stay until retention ends."]),
				],
			),
		],
	})
}

const connectedView = (h: H, model: Model, status: VercelIntegrationStatus, timeZone: string): Html =>
	vstack(
		h,
		{ gap: "4" },
		[
			summary(h, model, status, timeZone),
			...Arr.map(vercelIssues(status), (issue) => issueAlert(h, model, issue)),
			quickMetrics(h, model, status),
			vstack(h, { gap: "4", className: "lg:flex-row lg:items-start" }, [
				projectsPanel(h, model, status, timeZone),
				drainsPanel(h, status),
			]),
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
				title: "Couldn't load the Vercel integration",
				onRetry: Message.ClickedRetryStatus({ name: "vercel" }),
			}),
		onStale: ({ data }) => byStatus(h, model, data, timeZone),
		onRefreshing: (data) => byStatus(h, model, data, timeZone),
		onSuccess: (data) => byStatus(h, model, data, timeZone),
	}),
	...vercelConfigure(h, model),
]
