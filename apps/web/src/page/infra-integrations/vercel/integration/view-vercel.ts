import type { VercelIntegrationStatus, VercelProjectStatus } from "@maple/domain/http"
import { Array as Arr, Order, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	drainState,
	vercelHealthChip,
	vercelIssues,
	VERCEL_DRAINS,
	type VercelDrainFlag,
	type VercelIssue,
} from "./vercel-model"
import { AppRoute, hrefOf } from "../../../../route"
import { alert, alertAction, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button, linkButton } from "@maple/views/ui/button"
import { choiceCheckClass } from "@maple/views/ui/choice-card"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { badge } from "@maple/views/ui/display"
import { emptyMessage } from "@maple/views/ui/empty"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { panel } from "@maple/views/ui/panel"
import { dividedList } from "@maple/views/ui/rule"
import { skeleton } from "@maple/views/ui/skeleton"
import { integrationStatusCard } from "../../../integrations/view-integration-card"
import { hstack, vstack, vstackClass } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import {
	integrationEmpty,
	integrationEmptyCard,
	integrationEmptyFeatures,
	integrationEmptyFooter,
	integrationEmptyHint,
	integrationEmptyMedia,
} from "../../../kit/integration-empty"
import { relativeTime } from "../../../kit/relative-time"
import { providerBrand } from "../../../kit/providers"
import { Message } from "../../../integrations/message"
import { VercelMessage } from "./vercel"
import { canManage, type Model } from "../../../integrations/model"
import { vercelStatusOf } from "./update-vercel"
import { toHub, vercelConfigure } from "./view-vercel-configure"

// `VercelIntegrationCard`: not connected, or the connection itself: what Maple receives, from
// which projects, with which token. Traffic numbers live on `/infra/vercel`.

type H = HtmlBuilder<Message>

const BRAND = providerBrand("vercel")

/** The drains Maple installed, as Vercel lists them: only the enabled signals have one. */
export const drainNamesOf = (status: Pick<VercelIntegrationStatus, VercelDrainFlag>) =>
	Arr.flatMap(VERCEL_DRAINS, ({ flag, drain }) => (status[flag] ? [drain] : []))

const mono = (h: H, text: string): Html => typography(h, { tone: "foreground", mono: true }, [text])

const TONE_TEXT = { ok: "muted", warn: "warning", crit: "error", neutral: "muted" } as const

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
							"Paste a Vercel token. Maple creates a logs, a traces and an AI Gateway drain on the team you pick.",
						]),
						button(
							h,
							{
								attributes: [
									h.OnClick(toHub(VercelMessage.ClickedConfigure({ target: "connect" }))),
								],
							},
							[icon(h, "VercelIcon"), "Connect Vercel"],
						),
						integrationEmptyFooter(h, [
							"Needs Vercel Pro or Enterprise · Vercel bills drains by volume · sampling lowers it",
						]),
					]
				: [
						integrationEmptyHint(h, [
							"A Maple organization admin connects Vercel with a team token.",
						]),
					]),
		]),
	])

// HEADER

/** The health chip, then the team, when it connected and when Maple last synced it. */
const headerStatus = (h: H, model: Model, status: VercelIntegrationStatus, timeZone: string): Html => {
	const chip = vercelHealthChip(status)
	const team = status.team
	return hstack(h, { gap: "2", wrap: true }, [
		badge(h, { variant: chip.tone === "neutral" ? "outline" : chip.tone }, [chip.label]),
		typography(h, { size: "xs", tone: "muted" }, [
			...(team === null
				? []
				: [
						`Team ${team.name}`,
						...(team.plan == null ? [] : [` (${Str.capitalize(team.plan)})`]),
						" · ",
					]),
			...(status.connectedAt === null
				? []
				: [
						relativeTime(h, {
							value: status.connectedAt,
							nowMs: model.nowMs,
							timeZone,
							variant: "orDate",
							prefix: "connected",
						}),
						" · ",
					]),
			status.lastSuccessAt === null
				? "waiting for the first sync"
				: relativeTime(h, {
						value: status.lastSuccessAt,
						nowMs: model.nowMs,
						timeZone,
						prefix: "synced",
					}),
		]),
	])
}

/** `VercelHeaderStatus`: the integration header's status line while Vercel is connected. */
export const vercelHeaderStatus = (h: H, model: Model, timeZone: string): Html | undefined => {
	const status = vercelStatusOf(model)
	return status === null || !status.connected ? undefined : headerStatus(h, model, status, timeZone)
}

/** `VercelHeaderActions`: Sync now for admins, and the way to the Vercel dashboard. */
export const vercelHeaderActions = (h: H, model: Model): ReadonlyArray<Html> => [
	...(canManage(model)
		? [
				button(
					h,
					{
						size: "sm",
						variant: "outline",
						isLoading: model.vercelCard.isSyncing,
						attributes: [h.OnClick(toHub(VercelMessage.ClickedSync()))],
					},
					[icon(h, "ArrowRotateClockwiseIcon"), "Sync now"],
				),
			]
		: []),
	linkButton(h, { size: "sm", href: hrefOf(AppRoute.InfraVercel({ search: {} })) }, [
		"Open Vercel dashboard",
		icon(h, "ArrowRightIcon"),
	]),
]

// CONNECTED

/** A titled block of the page: the heading, a one-line hint and its action, then the body. */
const section = (
	h: H,
	options: Readonly<{ title: string; hint: string; action?: Html | undefined }>,
	children: ReadonlyArray<Html>,
): Html =>
	vstack(h, { as: "section", gap: "3" }, [
		hstack(h, { gap: "3", justify: "between", align: "end", wrap: true }, [
			vstack(h, { gap: "0.5", shrink: true }, [
				heading(h, { level: 2, variant: "section" }, [options.title]),
				typography(h, { as: "p", size: "xs", tone: "muted" }, [options.hint]),
			]),
			...(options.action === undefined ? [] : [options.action]),
		]),
		...children,
	])

const issueAlert = (h: H, model: Model, issue: VercelIssue): Html =>
	alert(h, { variant: issue.tone }, [
		icon(h, "CircleWarningIcon"),
		alertTitle(h, [issue.title]),
		alertDescription(h, [
			h.span([], [issue.description]),
			...(issue.vercelError === null
				? []
				: [
						h.span(
							[h.Class("font-mono text-2xs [overflow-wrap:anywhere]")],
							["Vercel: ", issue.vercelError],
						),
					]),
		]),
		...(canManage(model)
			? [
					alertAction(h, [
						issue.fix === "token"
							? button(
									h,
									{
										size: "sm",
										attributes: [
											h.OnClick(
												toHub(VercelMessage.ClickedConfigure({ target: "token" })),
											),
										],
									},
									["Paste a new token"],
								)
							: button(
									h,
									{
										size: "sm",
										variant: "outline",
										isLoading: model.vercelCard.isReapplying,
										attributes: [h.OnClick(toHub(VercelMessage.ClickedReapply()))],
									},
									["Re-apply drains"],
								),
					]),
				]
			: []),
	])

/** What each drain carries, and the part of Maple it feeds. */
const SIGNALS = {
	logs: {
		title: "Logs",
		carries: "Requests, status, cache, WAF, function logs",
		powers: "Traffic, errors, cache",
	},
	traces: {
		title: "Traces",
		carries: "Edge routing, function invocations, cold starts",
		powers: "Latency, cold starts, calls out",
	},
	aiGateway: {
		title: "AI Gateway",
		carries: "Model, tokens, cost, failovers per request",
		powers: "AI spend, agent sessions",
	},
	speedInsights: {
		title: "Speed Insights",
		carries: "LCP, INP, CLS, FCP, TTFB from real browsers",
		powers: "Real users",
	},
	webAnalytics: {
		title: "Web Analytics",
		carries: "Page views, referrers, countries, custom events",
		powers: "Real users",
	},
	auditLog: {
		title: "Audit log",
		carries: "Team actions: env vars, domains, members",
		powers: "Security audit log, org admins only",
	},
} as const satisfies Record<(typeof VERCEL_DRAINS)[number]["key"], unknown>

/** Vercel samples only logs and traces. */
const SAMPLED = new Set<string>(["logs", "traces"])

const configureButton = (h: H, model: Model, label: string): Html | undefined =>
	canManage(model)
		? button(
				h,
				{
					size: "sm",
					variant: "outline",
					attributes: [h.OnClick(toHub(VercelMessage.ClickedConfigure({ target: "configure" })))],
				},
				[label],
			)
		: undefined

/** The six drains: what each carries, what it powers, its sampling and its state on Vercel. */
const receivesSection = (h: H, model: Model, status: VercelIntegrationStatus): Html =>
	section(
		h,
		{
			title: "What Maple receives",
			hint: "Each signal is a drain on your Vercel team. Vercel bills drained data on Pro and Enterprise.",
			action: configureButton(h, model, "Configure"),
		},
		[
			panel(h, {}, [
				table(h, { ariaLabel: "Vercel drains" }, [
					tableHeader(h, [
						tableRow(h, [
							tableHead(h, ["Signal"], "w-full pl-4"),
							tableHead(h, ["Powers"], "hidden md:table-cell"),
							tableHead(h, ["Sampling"], "text-right"),
							tableHead(h, ["State"], "pr-4 text-right"),
						]),
					]),
					tableBody(
						h,
						Arr.map(VERCEL_DRAINS, ({ flag, key }) => {
							const signal = SIGNALS[key]
							const state = drainState(status[flag], status.drains[key])
							return tableRow(
								h,
								[
									tableCell(
										h,
										[
											hstack(h, { gap: "2.5", align: "start" }, [
												statusDot(h, { tone: state.tone, className: "mt-1.5" }),
												vstack(h, { gap: "1", shrink: true }, [
													typography(h, { weight: "medium", mono: true }, [
														signal.title,
													]),
													typography(
														h,
														{ size: "xs", tone: "muted", truncate: true },
														[signal.carries],
													),
												]),
											]),
										],
										"max-w-0 pl-4",
									),
									tableCell(
										h,
										[typography(h, { size: "xs", tone: "muted" }, [signal.powers])],
										"hidden md:table-cell",
									),
									tableCell(
										h,
										[
											typography(h, { size: "xs", mono: true, numeric: true }, [
												SAMPLED.has(key) && status[flag]
													? `${Math.round(status.samplingRate * 100)}%`
													: "—",
											]),
										],
										"text-right",
									),
									tableCell(
										h,
										[
											typography(
												h,
												{
													size: "xs",
													tone: TONE_TEXT[state.tone],
													className: "inline-block max-w-64 truncate align-middle",
													attributes: [h.Title(state.label)],
												},
												[state.label],
											),
										],
										"pr-4 text-right",
									),
								],
								undefined,
								[h.Key(key)],
							)
						}),
					),
				]),
			]),
		],
	)

/** A forwarded project's tick: read-only, the scope is edited in the configure dialog. */
const forwardedCheck = (h: H, isChecked: boolean): Html =>
	hstack(
		h,
		{
			as: "span",
			justify: "center",
			className: choiceCheckClass(isChecked),
			attributes: [h.AriaHidden(true)],
		},
		isChecked ? [icon(h, "CheckIcon", { size: 12 })] : [],
	)

const projectRow = (h: H, model: Model, project: VercelProjectStatus, timeZone: string): Html => {
	const deployment = project.productionDeployment
	return hstack(h, { as: "li", gap: "3", className: "px-4 py-2.5", attributes: [h.Key(project.id)] }, [
		forwardedCheck(h, project.forwarded),
		hstack(h, { gap: "2", grow: true, shrink: true }, [
			project.forwarded
				? textLink(
						h,
						{
							href: hrefOf(AppRoute.InfraVercelProject({ projectId: project.id, search: {} })),
							tone: "inherit",
							isMono: true,
							className: "min-w-0 truncate",
						},
						[project.name],
					)
				: typography(h, { mono: true, tone: "muted", truncate: true }, [project.name]),
			...(project.framework === null
				? []
				: [badge(h, { variant: "meta", size: "xs" }, [project.framework])]),
		]),
		typography(h, { size: "xs", tone: "muted", className: "shrink-0" }, [
			project.forwarded ? "forwarded" : "not forwarded",
		]),
		h.span(
			[h.Class("w-24 shrink-0 text-right")],
			[
				deployment === null
					? typography(
							h,
							{ size: "xs", tone: "muted", attributes: [h.Title("No production deploy")] },
							["—"],
						)
					: relativeTime(h, {
							value: deployment.createdAt,
							nowMs: model.nowMs,
							timeZone,
							variant: "short",
							prefix: "deployed",
							className: "text-xs text-muted-foreground",
						}),
			],
		),
	])
}

/** Every team project, forwarded first; the scope is read-only here and edited in the dialog. */
const projectsSection = (h: H, model: Model, status: VercelIntegrationStatus, timeZone: string): Html => {
	const projects = Arr.sort(
		status.projects,
		Order.combineAll([
			Order.mapInput(Order.flip(Order.Boolean), (project: VercelProjectStatus) => project.forwarded),
			Order.make((a: VercelProjectStatus, b: VercelProjectStatus) => Str.localeCompare(b.name)(a.name)),
		]),
	)
	const forwarded = Arr.filter(status.projects, (project) => project.forwarded).length
	const editScope = configureButton(h, model, "Edit scope")
	return section(
		h,
		{
			title: "Projects",
			hint: "New projects on the team are included automatically when the scope is All.",
			action: hstack(h, { gap: "2" }, [
				badge(h, { variant: "outline" }, [
					status.projectScope === "all"
						? "All projects"
						: `Selected · ${forwarded} of ${status.projects.length}`,
				]),
				...(editScope === undefined ? [] : [editScope]),
			]),
		},
		[
			panel(h, {}, [
				projects.length === 0
					? emptyMessage(h, { className: "py-8" }, [
							"Projects appear after the first sync, within a few minutes",
						])
					: dividedList(
							h,
							{ as: "ul", bordered: false, attributes: [h.AriaLabel("Vercel projects")] },
							Arr.map(projects, (project) => projectRow(h, model, project, timeZone)),
						),
			]),
		],
	)
}

/** The saved token: where it is scoped, whether Vercel still accepts it, and the actions that end it. */
const accessSection = (h: H, model: Model, status: VercelIntegrationStatus, timeZone: string): Html =>
	vstack(h, { as: "section", gap: "3" }, [
		heading(h, { level: 2, variant: "section" }, ["Access"]),
		panel(h, { padded: true }, [
			hstack(h, { gap: "3", wrap: true }, [
				icon(h, "KeyIcon", { size: 16, className: "shrink-0 text-muted-foreground" }),
				vstack(h, { gap: "0.5", grow: true, shrink: true }, [
					typography(h, { size: "sm", weight: "medium" }, [
						"Vercel access token",
						...(status.team === null ? [] : [" · scoped to ", mono(h, status.team.slug)]),
					]),
					typography(h, { size: "xs", tone: status.authFailed ? "error" : "muted" }, [
						"Encrypted at rest · ",
						status.authFailed
							? "rejected by Vercel"
							: status.lastSuccessAt === null
								? "not used yet"
								: relativeTime(h, {
										value: status.lastSuccessAt,
										nowMs: model.nowMs,
										timeZone,
										prefix: "last accepted by Vercel",
									}),
					]),
				]),
				...(canManage(model)
					? [
							hstack(h, { gap: "2" }, [
								button(
									h,
									{
										size: "sm",
										variant: "outline",
										attributes: [
											h.OnClick(
												toHub(VercelMessage.ClickedConfigure({ target: "token" })),
											),
										],
									},
									["Replace token"],
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
							]),
						]
					: [
							typography(h, { size: "xs", tone: "muted" }, [
								"Only Maple organization admins can replace the token or disconnect Vercel.",
							]),
						]),
			]),
		]),
	])

/** `ConfirmDialog` before disconnecting: what goes on Vercel at once, and what stays in Maple. */
const disconnectDialog = (h: H, model: Model, status: VercelIntegrationStatus): Html => {
	const names = drainNamesOf(status)
	const team = status.team?.name ?? "the team"
	const drains = [
		"the ",
		...Arr.flatMap(names, (name, index) => [
			...(index === 0 ? [] : [index === names.length - 1 ? " and " : ", "]),
			mono(h, name),
		]),
		names.length > 1 ? " drains" : " drain",
	]
	const fact = (term: string, detail: ReadonlyArray<Html | string>): Html =>
		h.div(
			[],
			[
				h.dt([h.Class("font-medium")], [term]),
				h.dd([h.Class("text-pretty text-muted-foreground")], detail),
			],
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
					fact("In Maple", [
						"Removes the token. Data the drains already sent to Maple stays until retention ends.",
					]),
				],
			),
		],
	})
}

const connectedView = (h: H, model: Model, status: VercelIntegrationStatus, timeZone: string): Html => {
	const issues = vercelIssues(status)
	return vstack(h, { gap: "8" }, [
		...(issues.length === 0
			? []
			: [
					vstack(
						h,
						{ gap: "3" },
						Arr.map(issues, (issue) => issueAlert(h, model, issue)),
					),
				]),
		receivesSection(h, model, status),
		projectsSection(h, model, status, timeZone),
		accessSection(h, model, status, timeZone),
		disconnectDialog(h, model, status),
	])
}

const byStatus = (h: H, model: Model, status: VercelIntegrationStatus, timeZone: string): Html =>
	status.connected ? connectedView(h, model, status, timeZone) : notConnected(h, model)

/** The card, and the configuration dialog it opens (connect, Configure, a new token). */
export const vercelCard = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => [
	integrationStatusCard(h, model.statuses.vercel, {
		name: "vercel",
		failureTitle: "Couldn't load the Vercel integration",
		render: (data) => byStatus(h, model, data, timeZone),
		loading: () => skeleton(h, "h-40 w-full rounded-md"),
	}),
	...vercelConfigure(h, model),
]
