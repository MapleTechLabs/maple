import type { V2SetupAudit, V2SetupAuditCheck } from "@maple/domain/http/v2"
import { countLabel } from "@maple/ui/lib/format"
import { TONE_FILL, TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { collapsible } from "@maple/views/ui/collapsible"
import { badge } from "@maple/views/ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { icon, type IconName } from "@maple/views/ui/icon"
import { inlineCode, inlineCodeClassName } from "@maple/views/ui/inline-code"
import { panel } from "@maple/views/ui/panel"
import { refreshButton } from "@maple/views/ui/refresh-button"
import { skeletonBlock } from "@maple/views/ui/skeleton"
import { relativeTime } from "../../kit/relative-time"
import { docsLink } from "../../kit/signal-empty-state"
import { emptyActions } from "@maple/views/ui/signal-empty-state"
import { settingsSection, settingsSections } from "../kit/section"
import {
	type HealthSegment,
	healthSegments,
	orderFindings,
	resolvedChecks,
	type SetupHealthAction,
	setupHealthAction,
} from "./derive"
import { Message, type Model } from "./model"
import { linkButton } from "@maple/views/ui/button"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

type H = HtmlBuilder<Message>
type Inputs = Readonly<{ nowMs: number; timeZone: string }>

const SEVERITY = {
	critical: { label: "Critical", icon: "CircleWarningIcon", text: TONE_TEXT.crit },
	warn: { label: "Warning", icon: "CircleWarningIcon", text: TONE_TEXT.warn },
	info: { label: "Info", icon: "CircleInfoIcon", text: TONE_TEXT.done },
} as const satisfies {
	readonly [Severity in V2SetupAuditCheck["severity"]]: { label: string; icon: IconName; text: string }
}

const SEGMENT = {
	critical: { fill: TONE_FILL.crit, legend: (n: number) => `${n} critical` },
	warn: { fill: TONE_FILL.warn, legend: (n: number) => countLabel(n, "warning") },
	info: { fill: TONE_FILL.done, legend: (n: number) => `${n} info` },
	pass: { fill: TONE_FILL.ok, legend: (n: number) => `${n} passing` },
	skip: { fill: TONE_FILL.neutral, legend: (n: number) => `${n} skipped` },
} as const satisfies {
	readonly [Segment in HealthSegment]: { fill: string; legend: (count: number) => string }
}

const CATEGORY_LABEL = {
	alerting: "Alerting",
	notifications: "Notifications",
	ingestion: "Ingestion",
	attributes: "Attributes",
	traces: "Traces",
	integrations: "Integrations",
	data_platform: "Data platform",
} as const satisfies { readonly [Category in V2SetupAuditCheck["category"]]: string }

const actionButton = (h: H, action: SetupHealthAction): Html =>
	action.kind === "docs"
		? linkButton(
				h,
				{
					variant: "outline",
					size: "sm",
					className: "shrink-0 gap-1.5",
					href: action.href,
					attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
				},
				[action.label, icon(h, "ExternalLinkIcon", { size: 14 })],
			)
		: linkButton(
				h,
				{ variant: "outline", size: "sm", className: "shrink-0 gap-1.5", href: action.href },
				[action.label, icon(h, "ArrowRightIcon", { size: 14 })],
			)

const chipClassName = "text-2xs leading-4"

const affectedChip = (h: H, entity: V2SetupAuditCheck["affected"][number], index: number): Html => {
	const title = entity.note === null ? [] : [h.Title(entity.note)]
	const key = h.Key(entity.id === null ? `index:${index}` : `id:${entity.kind}:${entity.id}`)
	if (entity.kind === "service")
		return h.a(
			[key, h.Href(`/services/${encodeURIComponent(entity.name)}`), ...title],
			[
				inlineCode(
					h,
					{
						className: cn(
							chipClassName,
							"text-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground active:decoration-foreground",
						),
					},
					[entity.name],
				),
			],
		)
	return h.code(
		[
			key,
			...title,
			h.Class(inlineCodeClassName("chip", cn(chipClassName, "text-muted-foreground"))),
			h.DataAttribute("slot", "inline-code"),
		],
		[entity.name],
	)
}

const findingRow = (h: H, check: V2SetupAuditCheck): Html => {
	const severity = SEVERITY[check.severity]
	const action = setupHealthAction(check)
	return h.li(
		[h.Key(check.id), h.Class("flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start")],
		[
			hstack(h, { gap: "3", align: "start", shrink: true, grow: true }, [
				icon(h, severity.icon, {
					size: 16,
					className: cn("mt-0.5 shrink-0", severity.text),
					attributes: [h.AriaLabel(severity.label)],
				}),
				vstack(h, { gap: "1.5", shrink: true }, [
					hstack(h, { align: "center", wrap: true, className: "gap-x-2 gap-y-0.5" }, [
						typography(h, { size: "sm", weight: "medium" }, [check.title]),
						typography(h, { size: "2xs", tone: "subtle" }, [CATEGORY_LABEL[check.category]]),
					]),
					...(check.detail === null
						? []
						: [
								typography(
									h,
									{ size: "xs", tone: "muted", as: "p", className: "leading-relaxed" },
									[check.detail],
								),
							]),
					typography(h, { size: "xs", tone: "subtle", as: "p", className: "leading-relaxed" }, [
						check.fix_hint,
					]),
					...(check.affected.length === 0
						? []
						: [
								hstack(h, { gap: "1.5", align: "center", wrap: true, className: "pt-0.5" }, [
									...Arr.map(check.affected, (entity, index) =>
										affectedChip(h, entity, index),
									),
									...(check.affected_count > check.affected.length
										? [
												typography(h, { size: "2xs", tone: "subtle" }, [
													"+",
													String(check.affected_count - check.affected.length),
													" more",
												]),
											]
										: []),
								]),
							]),
				]),
			]),
			...(action === null ? [] : [h.div([h.Class("pl-7 sm:pl-0")], [actionButton(h, action)])]),
		],
	)
}

const summaryPanel = (h: H, audit: V2SetupAudit, isRefreshing: boolean, inputs: Inputs): Html => {
	const segments = healthSegments(audit.summary)
	return panel(h, { className: "gap-3 p-4" }, [
		hstack(h, { align: "center", wrap: true, className: "gap-x-3 gap-y-1" }, [
			h.p(
				[h.Class("text-title font-medium")],
				[String(audit.summary.pass), " of ", countLabel(audit.checks.length, "check"), " passing"],
			),
			h.div([h.Class("grow")], []),
			typography(h, { size: "2xs", tone: "subtle" }, [
				"Last run ",
				relativeTime(h, {
					value: audit.generated_at,
					nowMs: inputs.nowMs,
					timeZone: inputs.timeZone,
				}),
			]),
			refreshButton(h, {
				variant: "ghost",
				label: "Re-run",
				isPending: isRefreshing,
				onRefresh: Message.ClickedRerun(),
			}),
		]),
		hstack(
			h,
			{
				gap: "0.5",
				align: "stretch",
				className: "h-1.5 w-full overflow-hidden rounded-full",
				attributes: [h.AriaHidden(true)],
			},
			Arr.map(segments, ({ segment, count }) =>
				h.div(
					[
						h.Key(segment),
						h.Class(cn("h-full", SEGMENT[segment].fill)),
						h.Style({ "flex-grow": String(count) }),
					],
					[],
				),
			),
		),
		hstack(
			h,
			{ align: "center", wrap: true, as: "ul", className: "gap-x-4 gap-y-1" },
			Arr.map(segments, ({ segment, count }) =>
				hstack(
					h,
					{
						gap: "1.5",
						align: "center",
						as: "li",
						className: "text-2xs",
						attributes: [h.Key(segment)],
					},
					[
						h.span([h.Class(cn("size-2 rounded-full", SEGMENT[segment].fill))], []),
						SEGMENT[segment].legend(count),
					],
				),
			),
		),
	])
}

const noTelemetry = (h: H): Html =>
	panel(h, {}, [
		empty(
			h,
			[
				emptyHeader(h, [
					emptyMedia(h, { variant: "icon" }, [icon(h, "ServerIcon", { size: 16 })]),
					emptyTitle(h, ["No telemetry yet"]),
					emptyDescription(h, [
						"Setup health runs once your first service reports in. Connect one from the Ingestion tab and come back.",
					]),
				]),
				emptyActions(h, [
					linkButton(h, { variant: "outline", size: "sm", href: "/settings?tab=ingestion" }, [
						"Go to Ingestion",
					]),
					docsLink(h, "quickstart"),
				]),
			],
			"py-10",
		),
	])

const findings = (h: H, audit: V2SetupAudit): Html => {
	const rows = orderFindings(audit.checks)
	return settingsSection(
		h,
		{
			id: "setup-health-findings-heading",
			title: "Needs attention",
			description: ["Most severe first. Each fix opens the exact place to change."],
			padded: false,
		},
		[
			rows.length === 0
				? vstack(h, { gap: "2", align: "center", className: "px-4 py-10 text-center" }, [
						icon(h, "CircleCheckIcon", { size: 20, className: TONE_TEXT.info }),
						typography(h, { size: "sm", weight: "medium", as: "p" }, ["Everything checks out"]),
						typography(h, { size: "xs", tone: "muted", as: "p" }, [
							"Alerts can deliver, and your telemetry follows the conventions Maple reads.",
						]),
					])
				: h.ul(
						[h.Class("divide-border divide-y")],
						Arr.map(rows, (check) => findingRow(h, check)),
					),
		],
	)
}

const passingDisclosure = (
	h: H,
	model: Model,
	checks: ReadonlyArray<V2SetupAuditCheck>,
): ReadonlyArray<Html> => {
	const { checks: passing, label } = resolvedChecks(checks)
	if (passing.length === 0) return []
	return [
		panel(h, { className: "overflow-hidden" }, [
			collapsible(
				h,
				{
					isOpen: model.isPassingOpen,
					onToggle: Message.ToggledPassing(),
					panelId: "setup-health-passing",
					triggerClassName:
						"group hover:bg-surface-sunken active:bg-surface-sunken flex w-full items-center gap-3 px-4 py-3 text-left",
					trigger: [
						icon(h, "ChevronRightIcon", {
							size: 14,
							className:
								"text-muted-foreground shrink-0 transition-transform group-data-panel-open:rotate-90",
						}),
						icon(h, "CircleCheckIcon", { size: 16, className: cn("shrink-0", TONE_TEXT.info) }),
						typography(h, { size: "sm", weight: "medium" }, [label]),
						typography(h, { size: "xs", tone: "muted", className: "min-w-0 flex-1" }, [
							"Checks are skipped only when telemetry could not be read",
						]),
					],
				},
				[
					h.div(
						[],
						[
							h.ul(
								[h.Class("divide-border divide-y border-t")],
								Arr.map(passing, (check) =>
									hstack(
										h,
										{
											gap: "3",
											align: "center",
											as: "li",
											className: "px-4 py-2.5",
											attributes: [h.Key(check.id)],
										},
										[
											check.status === "pass"
												? icon(h, "CircleCheckIcon", {
														size: 14,
														className: cn("shrink-0", TONE_TEXT.info),
													})
												: icon(h, "CircleInfoIcon", {
														size: 14,
														className: "text-foreground-subtle shrink-0",
													}),
											h.span([h.Class("min-w-0 flex-1 text-xs")], [check.title]),
											...(check.status === "skip"
												? [
														badge(h, { variant: "secondary", size: "xs" }, [
															"Skipped",
														]),
													]
												: []),
											typography(h, { size: "2xs", tone: "subtle" }, [
												CATEGORY_LABEL[check.category],
											]),
										],
									),
								),
							),
						],
					),
				],
			),
		]),
	]
}

const report = (h: H, audit: V2SetupAudit, isRefreshing: boolean, inputs: Inputs): ReadonlyArray<Html> => [
	summaryPanel(h, audit, isRefreshing, inputs),
	...(audit.telemetry_checks_available
		? []
		: [
				alert(h, { variant: "warn", className: "px-4 text-xs leading-relaxed" }, [
					icon(h, "CircleWarningIcon"),
					alertTitle(h, ["Telemetry checks skipped."]),
					alertDescription(h, [
						"Your warehouse could not be queried, so only configuration was checked. The findings below still apply.",
					]),
				]),
			]),
]

export const description = "Checks your instrumentation and workspace setup against what Maple needs."

export const view = Submodel.defineView<Model, Message, Inputs>((model, inputs, h) => {
	const audit = AsyncData.getOrElse(model.audit, () => null)
	const top = AsyncData.match(model.audit, {
		onIdle: () => [
			vstack(h, { gap: "4" }, [skeletonBlock(h, { height: "24" }), skeletonBlock(h, { height: "48" })]),
		],
		onLoading: () => [
			vstack(h, { gap: "4" }, [skeletonBlock(h, { height: "24" }), skeletonBlock(h, { height: "48" })]),
		],
		onFailure: (failure) => [
			errorState(h, { failure, title: "Couldn't check setup health", onRetry: Message.ClickedRetry() }),
		],
		onStale: ({ error }) => [
			errorState(h, {
				failure: error,
				title: "Couldn't check setup health",
				onRetry: Message.ClickedRetry(),
			}),
		],
		onRefreshing: (data) =>
			data.data_status === "no_data" ? [noTelemetry(h)] : report(h, data, true, inputs),
		onSuccess: (data) =>
			data.data_status === "no_data" ? [noTelemetry(h)] : report(h, data, false, inputs),
	})
	return settingsSections(h, [
		settingsSection(
			h,
			{
				id: "setup-health-heading",
				title: "Setup health",
				isLead: true,
				framed: false,
			},
			top,
		),
		...(audit !== null && audit.data_status === "ok"
			? [findings(h, audit), ...passingDisclosure(h, model, audit.checks)]
			: []),
	])
})
