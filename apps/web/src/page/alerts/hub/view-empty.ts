import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "../../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { inlineCode } from "../../../ui/inline-code"
import { docsLink, emptyActions } from "../../kit/signal-empty-state"
import { alertsHref, createHref } from "../shared/links"
import { ALERT_TEMPLATES, type AlertTemplate, type AlertTemplateId } from "../shared/templates"

// `AlertsEmptyState`: zero rules.

const TILE_TONE = new Map<AlertTemplateId, { glyph: string; hoverBorder: string }>([
	[
		"high_error_rate",
		{ glyph: "bg-chart-error/10 text-chart-error", hoverBorder: "hover:border-chart-error/50" },
	],
	["slow_p95", { glyph: "bg-chart-p95/10 text-chart-p95", hoverBorder: "hover:border-chart-p95/50" }],
	["slow_p99", { glyph: "bg-chart-p99/10 text-chart-p99", hoverBorder: "hover:border-chart-p99/50" }],
	[
		"low_apdex",
		{ glyph: "bg-chart-apdex/10 text-chart-apdex", hoverBorder: "hover:border-chart-apdex/50" },
	],
	[
		"throughput_drop",
		{
			glyph: "bg-chart-throughput/10 text-chart-throughput",
			hoverBorder: "hover:border-chart-throughput/50",
		},
	],
])

export type EmptyStateOptions<M> = Readonly<{
	isAdmin: boolean
	hasDestinations: boolean
	serviceName: string | undefined
	/** `useOpenDestinationDialog()`: set on `/alerts` for admins; otherwise the button links to Routing. */
	onAddDestination: M | undefined
}>

export const alertsEmptyState = <M>(h: HtmlBuilder<M>, options: EmptyStateOptions<M>): Html => {
	const needsDestination = !options.hasDestinations
	const description = !options.isAdmin
		? "Ask an admin to create the first alert rule."
		: needsDestination
			? "A rule opens an incident when a signal crosses a threshold, and sends it somewhere. Pick the somewhere first."
			: "A threshold rule opens an incident the moment a signal crosses it. Start from a common one:"
	return empty(
		h,
		[
			quietMonitor(h),
			emptyHeader(h, [
				emptyTitle(h, [
					needsDestination ? "Two steps to your first alert" : "No rules are watching yet",
				]),
				emptyDescription(h, [description]),
			]),
			...(options.isAdmin ? [adminSteps(h, options, needsDestination)] : [docsLink(h, "alertRules")]),
		],
		"py-12",
	)
}

const adminSteps = <M>(h: HtmlBuilder<M>, options: EmptyStateOptions<M>, needsDestination: boolean): Html =>
	h.div(
		[h.Class("flex w-full max-w-3xl flex-col items-center gap-4")],
		[
			...(needsDestination ? [destinationStep(h, options.onAddDestination), ruleStepHeader(h)] : []),
			h.div(
				[h.Class("grid w-full grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3")],
				ALERT_TEMPLATES.map((template) => templateTile(h, template, options.serviceName)),
			),
			emptyActions(h, [
				linkButton(
					h,
					{ variant: "ghost", size: "sm", href: createHref({ serviceName: options.serviceName }) },
					[icon(h, "PlusIcon"), "Start from scratch"],
				),
				docsLink(h, "alertRules"),
			]),
		],
	)

const destinationStep = <M>(h: HtmlBuilder<M>, onAddDestination: M | undefined): Html =>
	h.div(
		[
			h.Class(
				"flex w-full items-center gap-3 rounded-md border border-primary/40 bg-primary/[0.06] p-3 text-left",
			),
		],
		[
			stepBadge(h, 1),
			h.div(
				[h.Class("min-w-0 flex-1")],
				[
					h.p([h.Class("text-sm font-medium")], ["Add a destination"]),
					h.p(
						[h.Class("text-xs text-muted-foreground")],
						["Slack, Discord, PagerDuty, Telegram, email or a webhook. Rules notify these."],
					),
					docsLink(h, "destinations", "Destination setup"),
				],
			),
			onAddDestination === undefined
				? linkButton(h, { size: "sm", href: alertsHref({ tab: "routing" }) }, [
						icon(h, "PaperPlaneIcon"),
						"Add destination",
					])
				: button(h, { size: "sm", attributes: [h.OnClick(onAddDestination)] }, [
						icon(h, "PaperPlaneIcon"),
						"Add destination",
					]),
		],
	)

const ruleStepHeader = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class("flex w-full items-center gap-3 px-1 text-left")],
		[
			stepBadge(h, 2),
			h.p([h.Class("text-sm font-medium")], ["Create a rule"]),
			h.span([h.Class("text-xs text-muted-foreground")], ["Start from a common one:"]),
		],
	)

const stepBadge = <M>(h: HtmlBuilder<M>, n: number): Html =>
	h.span(
		[
			h.Class(
				"flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-xs font-semibold text-primary",
			),
		],
		[String(n)],
	)

const templateTile = <M>(
	h: HtmlBuilder<M>,
	template: AlertTemplate,
	serviceName: string | undefined,
): Html => {
	const tone = TILE_TONE.get(template.id)
	return h.a(
		[
			h.Href(createHref({ template: template.id, serviceName })),
			h.Class(
				cn(
					"group flex flex-col gap-1.5 rounded-md border bg-card p-3 text-left transition-colors",
					"hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
					tone?.hoverBorder,
				),
			),
		],
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					h.span(
						[
							h.Class(
								cn(
									"flex size-6 shrink-0 items-center justify-center rounded-md",
									tone?.glyph,
								),
							),
						],
						[icon(h, template.icon, { size: 13 })],
					),
					h.span([h.Class("font-medium text-sm")], [template.title]),
				],
			),
			inlineCode(h, { className: "self-start text-2xs text-muted-foreground" }, [template.summary]),
		],
	)
}

const svgAttrs = <M>(h: HtmlBuilder<M>, entries: Readonly<Record<string, string>>) =>
	Object.entries(entries).map(([name, value]) => h.Attribute(name, value))

/** `QuietMonitor`: a steady signal below the dashed threshold a rule would place. */
const quietMonitor = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class("relative w-full max-w-[300px] overflow-hidden rounded-md border bg-card/50 px-4 py-3")],
		[
			h.svg(
				svgAttrs(h, {
					viewBox: "0 0 300 84",
					class: "w-full",
					role: "img",
					"aria-label": "No threshold is watching yet",
				}),
				[
					h.title([], ["A steady signal running below an unset alert threshold"]),
					h.g(svgAttrs(h, { class: "infra-ref-line" }), [
						h.line(
							svgAttrs(h, {
								x1: "10",
								y1: "26",
								x2: "290",
								y2: "26",
								class: "stroke-primary",
								"stroke-width": "1.5",
								opacity: "0.55",
							}),
						),
					]),
					h.polyline(
						svgAttrs(h, {
							points: "10,60 30,58 48,61 66,57 86,60 104,58 124,61 142,59 160,57 178,60 196,58 214,61 232,58 250,60 268,58 290,59",
							fill: "none",
							class: "stroke-muted-foreground",
							"stroke-width": "1.75",
							"stroke-linecap": "square",
							"stroke-linejoin": "round",
							opacity: "0.7",
						}),
					),
					h.circle(
						svgAttrs(h, { cx: "290", cy: "59", r: "4", class: "fill-primary", opacity: "0.5" }),
					),
					h.circle(svgAttrs(h, { cx: "290", cy: "59", r: "2.5", class: "fill-primary" })),
				],
			),
		],
	)
