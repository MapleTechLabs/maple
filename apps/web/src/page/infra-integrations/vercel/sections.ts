import type {
	VercelAuditEvent,
	VercelDeploymentSummary,
	VercelInfraDependency,
	VercelInfraFunction,
	VercelSpeedInsightsResponse,
	VercelWebAnalyticsResponse,
	VercelWebAnalyticsTop,
	VercelWebVital,
} from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { ERROR_RATE_TEXT, errorRateLevel } from "@maple/ui/lib/error-rate"
import {
	EMPTY_VALUE,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import { TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "@maple/views/data/load-failure"
import {
	buildDurationMs,
	isFailedBuild,
	vercelBuildLogAttrs,
	vitalRating,
	vitalsByKey,
	type VitalRating,
	WEB_VITALS,
} from "./list-model"
import { deploymentStateLabel, deploymentTone, percentOf } from "./integration/vercel-model"
import { AppRoute, hrefOf } from "../../../route"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { textLink } from "@maple/views/ui/text-link"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { columnHead, dataTable, dataTableEmpty, skeletonRows } from "../../kit/data-table"
import { relativeTime } from "../../kit/relative-time"
import { sectionHeading } from "../../kit/section-heading"
import { statRail, statRailItem, statRailLoading } from "../../kit/stat-rail"
import { integrationLinkActions } from "../kit/empty-states"
import { type Clock, dataOf, failureOf, LEAD_COLUMN, ROW_CLASS } from "./view-parts"

// The sections the Vercel overview and project pages share. Each draws its own failed, loading,
// empty and drain-off state, so a page composes them without checking first.

/** One read behind a section, and the message that asks for it again. */
export type SectionRead<A, M> = Readonly<{ data: AsyncData.AsyncData<A, LoadFailure>; onRetry: M }>

const NUM = typographyClass({ size: "xs", tone: "soft", mono: true, numeric: true, className: "text-right" })

/** A notice that a drain (or the drain a number needs) is off, with the way to turn it on. */
export const drainNotice = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ lead: string; text: string; actionLabel: string }>,
): Html =>
	hstack(
		h,
		{
			gap: "3",
			justify: "between",
			wrap: true,
			className: "rounded-md border bg-surface-faint px-4 py-2.5",
		},
		[
			typography(h, { as: "p", size: "xs", tone: "muted" }, [
				typography(h, { weight: "medium", tone: "foreground" }, [`${options.lead} `]),
				options.text,
			]),
			integrationLinkActions(h, {
				integration: "vercel",
				actionLabel: options.actionLabel,
				actionVariant: "outline",
			}),
		],
	)

/** A drain the connection does not forward: what turning it on adds. */
export type DrainOff = Readonly<{ lead: string; text: string }>

export type SectionOptions<A, M> = Readonly<{
	title: string
	hint?: string
	actions?: Html
	read: SectionRead<A, M>
	/** Set when the drain feeding the section is off: the notice replaces the read. */
	off?: DrainOff | null
	failure: string
	loading: () => ReadonlyArray<Html>
	body: (data: A) => ReadonlyArray<Html>
}>

/** A titled section over one read: the drain-off notice, the failure, a skeleton, or the body. */
export const readSection = <A, M>(h: HtmlBuilder<M>, options: SectionOptions<A, M>): Html => {
	const heading = sectionHeading(h, { title: options.title, hint: options.hint, actions: options.actions })
	const off = options.off ?? null
	if (off !== null)
		return h.section(
			[h.Class("space-y-3")],
			[heading, drainNotice(h, { ...off, actionLabel: "Turn on in settings" })],
		)
	const failure = failureOf(options.read.data)
	const data = dataOf(options.read.data)
	return h.section(
		[h.Class("space-y-3")],
		[
			heading,
			...(failure !== null
				? [
						errorState(h, {
							failure,
							title: options.failure,
							onRetry: options.read.onRetry,
							variant: "row",
						}),
					]
				: data === null
					? options.loading()
					: options.body(data)),
		],
	)
}

const tableLoading = <M>(h: HtmlBuilder<M>, label: string, rows = 3): ReadonlyArray<Html> => [
	dataTable(
		h,
		{ ariaLabel: label },
		[],
		skeletonRows(h, rows, () => [skeleton(h, "h-3 w-full")]),
	),
]

const durationText = (ms: number | null) => (ms === null ? EMPTY_VALUE : formatLatency(ms))

// Builds

const MINUTE = 60_000

/** The logs explorer at one deployment's build output, over the build's own window. */
export const buildLogsHref = (deployment: VercelDeploymentSummary, nowMs: number): string =>
	hrefOf(
		AppRoute.Logs({
			search: {
				attrs: [...vercelBuildLogAttrs(deployment.id)],
				startTime: formatWarehouseDateTime(deployment.createdAt - MINUTE),
				endTime: formatWarehouseDateTime((deployment.readyAt ?? nowMs) + 5 * MINUTE),
			},
		}),
	)

const buildRow = <M>(
	h: HtmlBuilder<M>,
	deployment: VercelDeploymentSummary,
	clock: Clock,
	projectName: ((projectId: string) => string) | null,
): Html => {
	const failed = isFailedBuild(deployment)
	const reason = Arr.join(
		Arr.filter([deployment.errorCode ?? "", deployment.errorMessage ?? ""], Str.isNonEmpty),
		": ",
	)
	return h.div(
		[h.Key(deployment.id), h.Class(ROW_CLASS)],
		[
			hstack(h, { as: "span", gap: "1.5", className: "w-[104px] shrink-0 text-xs" }, [
				statusDot(h, { tone: deploymentTone(deployment.state), size: "lg" }),
				deploymentStateLabel(deployment.state),
			]),
			...(projectName === null
				? []
				: [
						typography(
							h,
							{
								size: "xs",
								tone: "foreground",
								mono: true,
								truncate: true,
								className: "w-[140px] shrink-0",
							},
							[projectName(deployment.projectId)],
						),
					]),
			vstack(h, { gap: "0.5", grow: true, className: "w-0 min-w-[220px]" }, [
				hstack(h, { as: "span", align: "baseline", gap: "2" }, [
					...(deployment.branch === null || deployment.branch === ""
						? []
						: [
								typography(
									h,
									{
										size: "2xs",
										tone: "soft",
										mono: true,
										className: "max-w-[40%] shrink-0",
										truncate: true,
									},
									[deployment.branch],
								),
							]),
					typography(
						h,
						{
							size: "xs",
							tone: "foreground",
							truncate: true,
							attributes:
								deployment.commitMessage === null ? [] : [h.Title(deployment.commitMessage)],
						},
						[
							deployment.commitMessage === null
								? deployment.url
								: (Str.split(deployment.commitMessage, "\n")[0] ?? deployment.url),
						],
					),
					...(deployment.commitSha === null || deployment.commitSha === ""
						? []
						: [
								typography(
									h,
									{ size: "3xs", tone: "muted", mono: true, className: "shrink-0" },
									[Str.slice(0, 7)(deployment.commitSha)],
								),
							]),
				]),
				...(failed && reason !== ""
					? [
							typography(
								h,
								{
									size: "2xs",
									mono: true,
									truncate: true,
									className: TONE_TEXT.crit,
									attributes: [h.Title(reason)],
								},
								[reason],
							),
						]
					: []),
			]),
			typography(h, { size: "2xs", tone: "muted", className: "hidden w-[88px] shrink-0 md:block" }, [
				deployment.target ?? "preview",
			]),
			h.span([h.Class(cn(NUM, "w-[72px] shrink-0"))], [durationText(buildDurationMs(deployment))]),
			h.span(
				[h.Class("w-[72px] shrink-0 text-right")],
				[
					relativeTime(h, {
						value: deployment.createdAt,
						...clock,
						variant: "short",
						mono: true,
						className: typographyClass({ size: "2xs", tone: "muted" }),
					}),
				],
			),
			hstack(h, { as: "span", gap: "2", justify: "end", className: "w-[96px] shrink-0" }, [
				typography(h, { size: "2xs" }, [
					textLink(h, { href: buildLogsHref(deployment, clock.nowMs), tone: "muted" }, [
						"Build logs",
					]),
				]),
				...(deployment.inspectorUrl === null
					? []
					: [
							textLink(
								h,
								{
									href: deployment.inspectorUrl,
									tone: "muted",
									attributes: [
										h.Target("_blank"),
										h.Rel("noopener noreferrer"),
										h.AriaLabel("Open in Vercel"),
										h.Title("Open in Vercel"),
									],
								},
								[icon(h, "ExternalLinkIcon", { size: 12 })],
							),
						]),
			]),
		],
	)
}

/** Recent deployments with their build time, state and why a failed one stopped. */
export const buildsSection = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		read: SectionRead<ReadonlyArray<VercelDeploymentSummary>, M>
		clock: Clock
		/** Names each row's project: the team-wide list. Null on one project's page. */
		projectName: ((projectId: string) => string) | null
	}>,
): Html => {
	const rows = dataOf(options.read.data)
	const failedCount = rows === null ? 0 : Arr.filter(rows, isFailedBuild).length
	return readSection(h, {
		title: "Builds",
		hint:
			rows === null || rows.length === 0
				? "newest first, from Vercel's API"
				: failedCount === 0
					? "newest first, none failed"
					: `newest first, ${failedCount} failed`,
		read: options.read,
		failure: "Couldn't load builds",
		loading: () => tableLoading(h, "Builds"),
		body: (deployments) => [
			dataTable(
				h,
				{ ariaLabel: "Builds" },
				[
					columnHead(h, { label: "State", width: "w-[104px]" }),
					...(options.projectName === null
						? []
						: [columnHead(h, { label: "Project", width: "w-[140px]" })]),
					columnHead(h, { label: "Commit", width: "w-0 flex-1 min-w-[220px]" }),
					columnHead(h, { label: "Target", width: "w-[88px]", hidden: "hidden md:flex" }),
					columnHead(h, { label: "Build", width: "w-[72px]", align: "right" }),
					columnHead(h, { label: "Created", width: "w-[72px]", align: "right" }),
					columnHead(h, { label: "", width: "w-[96px]" }),
				],
				deployments.length === 0
					? [
							dataTableEmpty(h, [
								"No builds recorded yet. Maple reads them from Vercel every few minutes.",
							]),
						]
					: Arr.map(deployments, (deployment) =>
							buildRow(h, deployment, options.clock, options.projectName),
						),
			),
		],
	})
}

// Functions

const TRACES_OFF: DrainOff = {
	lead: "Traces are off.",
	text: "Function invocations, cold starts and outbound calls come from Vercel's trace drain.",
}

const coldStartTone = (percent: number | null): string =>
	ERROR_RATE_TEXT[errorRateLevel(percent === null ? 0 : percent / 100)]

/** Per route: invocations, the share that started cold and what a cold start cost. */
export const functionsSection = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ read: SectionRead<ReadonlyArray<VercelInfraFunction>, M>; tracesEnabled: boolean }>,
): Html =>
	readSection(h, {
		title: "Functions",
		hint: "by route, most invoked first",
		read: options.read,
		off: options.tracesEnabled ? null : TRACES_OFF,
		failure: "Couldn't load functions",
		loading: () => tableLoading(h, "Functions"),
		body: (functions) => [
			dataTable(
				h,
				{ ariaLabel: "Functions" },
				[
					columnHead(h, { label: "Route", width: LEAD_COLUMN }),
					columnHead(h, { label: "Invocations", width: "w-[96px]", align: "right" }),
					columnHead(h, { label: "Cold starts", width: "w-[120px]", align: "right" }),
					columnHead(h, {
						label: "Init p50",
						width: "w-[80px]",
						align: "right",
						hidden: "hidden md:flex",
					}),
					columnHead(h, { label: "Init p95", width: "w-[80px]", align: "right" }),
					columnHead(h, { label: "p95", width: "w-[80px]", align: "right" }),
				],
				functions.length === 0
					? [dataTableEmpty(h, ["No function invocations in this window"])]
					: Arr.map(functions, (fn) => {
							const percent = percentOf(fn.coldStarts, fn.invocations)
							return h.div(
								[h.Key(fn.route), h.Class(ROW_CLASS)],
								[
									typography(
										h,
										{
											size: "xs",
											tone: fn.route === "" ? "muted" : "foreground",
											mono: true,
											truncate: true,
											className: LEAD_COLUMN,
											attributes: [h.Title(fn.route)],
										},
										[fn.route === "" ? "(no route)" : fn.route],
									),
									h.span([h.Class(cn(NUM, "w-[96px]"))], [formatNumber(fn.invocations)]),
									h.span(
										[h.Class(cn(NUM, "w-[120px]", coldStartTone(percent)))],
										[
											percent === null
												? EMPTY_VALUE
												: `${formatPercent(percent / 100)} · ${formatNumber(fn.coldStarts)}`,
										],
									),
									h.span(
										[h.Class(cn(NUM, "hidden w-[80px] md:block"))],
										[fn.initP50Ms === null ? EMPTY_VALUE : formatLatency(fn.initP50Ms)],
									),
									h.span(
										[h.Class(cn(NUM, "w-[80px]"))],
										[fn.initP95Ms === null ? EMPTY_VALUE : formatLatency(fn.initP95Ms)],
									),
									h.span([h.Class(cn(NUM, "w-[80px]"))], [formatLatency(fn.p95DurationMs)]),
								],
							)
						}),
			),
		],
	})

// Dependencies

/** The hosts a project's functions called: calls, failures and latency, beside the service map. */
export const dependenciesSection = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		read: SectionRead<ReadonlyArray<VercelInfraDependency>, M>
		tracesEnabled: boolean
		serviceMapHref: string
	}>,
): Html =>
	readSection(h, {
		title: "Dependencies",
		hint: "outbound calls from this project's functions",
		actions: typography(h, { size: "xs" }, [
			textLink(h, { href: options.serviceMapHref, tone: "muted" }, ["Open in the service map"]),
		]),
		read: options.read,
		off: options.tracesEnabled ? null : TRACES_OFF,
		failure: "Couldn't load dependencies",
		loading: () => tableLoading(h, "Dependencies"),
		body: (dependencies) => [
			dataTable(
				h,
				{ ariaLabel: "Dependencies" },
				[
					columnHead(h, { label: "Host", width: LEAD_COLUMN }),
					columnHead(h, { label: "Calls", width: "w-[88px]", align: "right" }),
					columnHead(h, { label: "Errors", width: "w-[88px]", align: "right" }),
					columnHead(h, {
						label: "p50",
						width: "w-[80px]",
						align: "right",
						hidden: "hidden md:flex",
					}),
					columnHead(h, { label: "p95", width: "w-[80px]", align: "right" }),
				],
				dependencies.length === 0
					? [dataTableEmpty(h, ["No outbound calls in this window"])]
					: Arr.map(dependencies, (dependency) => {
							const rate = (percentOf(dependency.errors, dependency.calls) ?? 0) / 100
							return h.div(
								[h.Key(dependency.host), h.Class(ROW_CLASS)],
								[
									typography(
										h,
										{
											size: "xs",
											tone: "foreground",
											mono: true,
											truncate: true,
											className: LEAD_COLUMN,
											attributes: [h.Title(dependency.host)],
										},
										[dependency.host],
									),
									h.span([h.Class(cn(NUM, "w-[88px]"))], [formatNumber(dependency.calls)]),
									h.span(
										[h.Class(cn(NUM, "w-[88px]", ERROR_RATE_TEXT[errorRateLevel(rate)]))],
										[formatErrorRate(rate)],
									),
									h.span(
										[h.Class(cn(NUM, "hidden w-[80px] md:block"))],
										[formatLatency(dependency.p50DurationMs)],
									),
									h.span(
										[h.Class(cn(NUM, "w-[80px]"))],
										[formatLatency(dependency.p95DurationMs)],
									),
								],
							)
						}),
			),
		],
	})

// Speed Insights

const RATING_TONE = { good: "ok", needsImprovement: "warn", poor: "crit" } as const satisfies Record<
	VitalRating,
	Tone
>
const RATING_LABEL = {
	good: "good",
	needsImprovement: "needs improvement",
	poor: "poor",
} as const satisfies Record<VitalRating, string>

const vitalText = (metric: VercelWebVital, p75: number | undefined) =>
	p75 === undefined ? EMPTY_VALUE : metric === "CLS" ? p75.toFixed(2) : formatLatency(p75)

const vitalsTable = <M>(
	h: HtmlBuilder<M>,
	title: string,
	keyLabel: string,
	readings: VercelSpeedInsightsResponse["routes"],
): Html => {
	const rows = vitalsByKey(readings)
	return h.section(
		[h.Class("min-w-0 space-y-3")],
		[
			sectionHeading(h, { title, hint: "p75", count: String(rows.length) }),
			dataTable(
				h,
				{ ariaLabel: title },
				[
					columnHead(h, { label: keyLabel, width: "w-0 flex-1 min-w-[160px]" }),
					...Arr.map(WEB_VITALS, (metric) =>
						columnHead(h, { label: metric, width: "w-[64px]", align: "right" }),
					),
					columnHead(h, {
						label: "Samples",
						width: "w-[72px]",
						align: "right",
						hidden: "hidden md:flex",
					}),
				],
				rows.length === 0
					? [dataTableEmpty(h, ["No readings in this window"])]
					: Arr.map(rows, (row) =>
							h.div(
								[h.Key(row.key), h.Class(ROW_CLASS)],
								[
									typography(
										h,
										{
											size: "xs",
											tone: "foreground",
											mono: true,
											truncate: true,
											className: "w-0 min-w-[160px] flex-1",
											attributes: [h.Title(row.key)],
										},
										[row.key === "" ? "(unknown)" : row.key],
									),
									...Arr.map(WEB_VITALS, (metric) => {
										const p75 = row.p75[metric]
										return h.span(
											[
												h.Class(
													cn(
														NUM,
														"w-[64px]",
														p75 === undefined
															? undefined
															: TONE_TEXT[
																	RATING_TONE[vitalRating(metric, p75)]
																],
													),
												),
											],
											[vitalText(metric, p75)],
										)
									}),
									h.span(
										[h.Class(cn(NUM, "hidden w-[72px] md:block"))],
										[formatNumber(row.samples)],
									),
								],
							),
						),
			),
		],
	)
}

const SPEED_INSIGHTS_OFF: DrainOff = {
	lead: "Speed Insights is off.",
	text: "Turn on the Speed Insights drain to see each page's Core Web Vitals from real visits.",
}

/** p75 of each Web Vital, rated; by route and device when the read is one project's. */
export const speedInsightsSection = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ read: SectionRead<VercelSpeedInsightsResponse, M>; enabled: boolean }>,
): Html =>
	readSection(h, {
		title: "Speed Insights",
		hint: "p75 from real visits",
		read: options.read,
		off: options.enabled ? null : SPEED_INSIGHTS_OFF,
		failure: "Couldn't load Speed Insights",
		loading: () => [statRailLoading(h, 5, 5)],
		body: (data) => {
			const overall = vitalsByKey(data.metrics)[0]
			if (overall === undefined)
				return [dataTableEmpty(h, ["No Speed Insights readings in this window"])]
			return [
				statRail(
					h,
					{ columns: 5 },
					Arr.map(WEB_VITALS, (metric) => {
						const p75 = overall.p75[metric]
						const rating = p75 === undefined ? null : vitalRating(metric, p75)
						return statRailItem(h, {
							eyebrow: metric,
							value: vitalText(metric, p75),
							tone: rating === null ? "neutral" : RATING_TONE[rating],
							subline: rating === null ? "no readings" : RATING_LABEL[rating],
						})
					}),
				),
				...(data.routes.length === 0 && data.devices.length === 0
					? []
					: [
							h.div(
								[h.Class("grid grid-cols-1 gap-6 xl:grid-cols-3")],
								[
									h.div(
										[h.Class("xl:col-span-2")],
										[vitalsTable(h, "By route", "Route", data.routes)],
									),
									vitalsTable(h, "By device", "Device", data.devices),
								],
							),
						]),
			]
		},
	})

// Web Analytics

const WEB_ANALYTICS_OFF: DrainOff = {
	lead: "Web Analytics is off.",
	text: "Turn on the Web Analytics drain to see page views, visitors, referrers and custom events.",
}

const topTable = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		title: string
		label: string
		countLabel: string
		rows: ReadonlyArray<VercelWebAnalyticsTop>
	}>,
): Html =>
	h.section(
		[h.Class("min-w-0 space-y-3")],
		[
			sectionHeading(h, { title: options.title, count: String(options.rows.length) }),
			dataTable(
				h,
				{ ariaLabel: options.title },
				[
					columnHead(h, { label: options.label, width: "w-0 flex-1 min-w-[140px]" }),
					columnHead(h, { label: options.countLabel, width: "w-[80px]", align: "right" }),
					columnHead(h, { label: "Devices", width: "w-[72px]", align: "right" }),
				],
				options.rows.length === 0
					? [dataTableEmpty(h, ["None in this window"])]
					: Arr.map(options.rows, (row) =>
							h.div(
								[h.Key(row.value), h.Class(ROW_CLASS)],
								[
									typography(
										h,
										{
											size: "xs",
											tone: "foreground",
											mono: true,
											truncate: true,
											className: "w-0 min-w-[140px] flex-1",
											attributes: [h.Title(row.value)],
										},
										[row.value === "" ? "(none)" : row.value],
									),
									h.span([h.Class(cn(NUM, "w-[80px]"))], [formatNumber(row.count)]),
									h.span([h.Class(cn(NUM, "w-[72px]"))], [formatNumber(row.devices)]),
								],
							),
						),
			),
		],
	)

/** Page views, devices and custom events; every breakdown, or only top pages (`compact`). */
export const webAnalyticsSection = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		read: SectionRead<VercelWebAnalyticsResponse, M>
		enabled: boolean
		compact: boolean
	}>,
): Html =>
	readSection(h, {
		title: "Web Analytics",
		hint: "from Vercel Web Analytics",
		read: options.read,
		off: options.enabled ? null : WEB_ANALYTICS_OFF,
		failure: "Couldn't load Web Analytics",
		loading: () => [statRailLoading(h, 3, 3)],
		body: (data) => {
			if (data.summary.pageViews === 0 && data.summary.customEvents === 0)
				return [dataTableEmpty(h, ["No page views in this window"])]
			const pages = topTable(h, {
				title: "Top pages",
				label: "Path",
				countLabel: "Views",
				rows: data.pages,
			})
			return [
				statRail(h, { columns: 3 }, [
					statRailItem(h, { eyebrow: "Page views", value: formatNumber(data.summary.pageViews) }),
					statRailItem(h, {
						eyebrow: "Unique devices",
						value: formatNumber(data.summary.uniqueDevices),
						subline: "device ids rotate daily",
					}),
					statRailItem(h, {
						eyebrow: "Custom events",
						value: formatNumber(data.summary.customEvents),
					}),
				]),
				options.compact
					? pages
					: h.div(
							[h.Class("grid grid-cols-1 gap-6 lg:grid-cols-2")],
							[
								pages,
								topTable(h, {
									title: "Referrers",
									label: "Referrer",
									countLabel: "Views",
									rows: data.referrers,
								}),
								topTable(h, {
									title: "Countries",
									label: "Country",
									countLabel: "Views",
									rows: data.countries,
								}),
								topTable(h, {
									title: "Custom events",
									label: "Event",
									countLabel: "Count",
									rows: data.events,
								}),
							],
						),
			]
		},
	})

// Audit log

const AUDIT_LOG_OFF: DrainOff = {
	lead: "The audit log is off.",
	text: "Turn on the Audit Log drain to see who changed the team: members, domains, env vars and drains.",
}

/** The team's newest audit log events. */
export const auditLogSection = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		read: SectionRead<ReadonlyArray<VercelAuditEvent>, M>
		enabled: boolean
		clock: Clock
		projectName: (projectId: string) => string
	}>,
): Html =>
	readSection(h, {
		title: "Audit log",
		hint: "newest first",
		read: options.read,
		off: options.enabled ? null : AUDIT_LOG_OFF,
		failure: "Couldn't load the audit log",
		loading: () => tableLoading(h, "Audit log"),
		body: (events) => [
			dataTable(
				h,
				{ ariaLabel: "Audit log" },
				[
					columnHead(h, { label: "Action", width: LEAD_COLUMN }),
					columnHead(h, { label: "Actor", width: "w-[160px]" }),
					columnHead(h, { label: "Project", width: "w-[140px]", hidden: "hidden md:flex" }),
					columnHead(h, { label: "When", width: "w-[72px]", align: "right" }),
				],
				events.length === 0
					? [dataTableEmpty(h, ["No audit events in this window"])]
					: Arr.map(events, (event, index) =>
							h.div(
								[h.Key(`${event.timestamp}:${index}`), h.Class(ROW_CLASS)],
								[
									typography(
										h,
										{
											size: "xs",
											tone: "foreground",
											mono: true,
											truncate: true,
											className: LEAD_COLUMN,
										},
										[event.action],
									),
									typography(
										h,
										{ size: "xs", tone: "soft", truncate: true, className: "w-[160px]" },
										[event.actor === "" ? event.actorType || EMPTY_VALUE : event.actor],
									),
									typography(
										h,
										{
											size: "xs",
											tone: "muted",
											mono: true,
											truncate: true,
											className: "hidden w-[140px] md:block",
										},
										[
											event.projectId === ""
												? "team"
												: options.projectName(event.projectId),
										],
									),
									h.span(
										[h.Class("w-[72px] text-right")],
										[
											relativeTime(h, {
												value: event.timestamp,
												...options.clock,
												variant: "short",
												mono: true,
												className: typographyClass({ size: "2xs", tone: "muted" }),
											}),
										],
									),
								],
							),
						),
			),
		],
	})
