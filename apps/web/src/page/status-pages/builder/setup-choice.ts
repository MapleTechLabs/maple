import { DEFAULT_STATUS_PAGE_THEME, resolveStatusPageTheme } from "@maple/domain/status-page"
import { cn } from "@maple/ui/lib/utils"
import { linkButton } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { grid } from "@maple/views/ui/grid"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { newStatusPageHref } from "../shared/commands"

// `/status-pages/new` before a method is picked: the agent and the dashboard as two cards, each
// with a picture of what that path looks like, and what both end with.

/** A path's picture, the same height in both cards so their titles line up. */
const previewPane = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.div(
		[h.AriaHidden(true), h.Class("m-2 h-52 overflow-hidden rounded-lg border bg-surface-sunken")],
		children,
	)

const AGENT_STEPS: ReadonlyArray<{ label: string; detail: string; isDone: boolean }> = [
	{ label: "Connected the Maple MCP", detail: "", isDone: true },
	{ label: "Found 4 public endpoints", detail: "api, app, ingest, docs", isDone: true },
	{ label: "Created 4 uptime monitors", detail: "60s interval", isDone: true },
	{ label: "Matched the page to your brand", detail: "#5B5BD6 · Inter · logo.svg", isDone: true },
	{ label: "Waiting for your approval", detail: "status.acme.com", isDone: false },
]

/** An agent's transcript as it sets the page up. */
const agentTranscript = <M>(h: HtmlBuilder<M>): Html =>
	vstack(h, { gap: "2.5", className: "p-3 font-mono text-xs" }, [
		hstack(h, { gap: "2", className: "border-b pb-2 text-muted-foreground" }, [
			icon(h, "SquareTerminalIcon", { size: 14 }),
			"claude · acme-web",
		]),
		typography(h, { tone: "foreground", as: "p" }, ["> Set up a status page for this project on Maple…"]),
		vstack(
			h,
			{ gap: "1.5" },
			Arr.map(AGENT_STEPS, (step) =>
				hstack(h, { gap: "2", shrink: true, attributes: [h.Key(step.label)] }, [
					icon(h, step.isDone ? "CheckIcon" : "CircleIcon", {
						size: 12,
						className: cn("shrink-0", step.isDone ? "text-success" : "text-warning"),
					}),
					typography(h, { tone: "foreground", className: "shrink-0" }, [step.label]),
					typography(h, { tone: "muted", truncate: true }, [step.detail]),
				]),
			),
		),
	])

const BUILDER_FIELDS: ReadonlyArray<{ label: string; value: string }> = [
	{ label: "Name", value: "Acme Status" },
	{ label: "Components", value: "API, Dashboard +2" },
	{ label: "Theme", value: "Light · #5B5BD6" },
]

const PAGE_COMPONENTS: ReadonlyArray<{ name: string; uptime: string; degradedTick: number | null }> = [
	{ name: "API", uptime: "99.98%", degradedTick: null },
	{ name: "Dashboard", uptime: "99.98%", degradedTick: null },
	{ name: "Ingest", uptime: "99.91%", degradedTick: 21 },
]

const TICKS = Arr.range(0, 29)

const THEME = resolveStatusPageTheme(DEFAULT_STATUS_PAGE_THEME)
/** The default theme's light mode: the mini page stays light in the dark dashboard. */
const PAGE = THEME.light

/** A status page as visitors get it, in miniature. */
const miniStatusPage = <M>(h: HtmlBuilder<M>): Html =>
	vstack(
		h,
		{
			gap: "1.5",
			grow: true,
			shrink: true,
			className: "rounded-md border p-2.5",
			attributes: [
				h.Style({
					backgroundColor: PAGE.bg,
					borderColor: PAGE.line,
					color: PAGE.fg,
					fontFamily: THEME.fontStack,
				}),
			],
		},
		[
			hstack(h, { gap: "1.5" }, [
				h.span([h.Class("size-2.5 rounded-xs"), h.Style({ backgroundColor: PAGE.fg })], []),
				typography(h, { size: "2xs", weight: "semibold" }, ["Acme Status"]),
			]),
			typography(
				h,
				{
					size: "3xs",
					weight: "medium",
					as: "div",
					className: "rounded-sm px-2 py-1",
					attributes: [h.Style({ backgroundColor: PAGE.ok, color: PAGE.card })],
				},
				["All systems operational"],
			),
			h.div(
				[
					h.Class("rounded-sm border"),
					h.Style({ backgroundColor: PAGE.card, borderColor: PAGE.line }),
				],
				Arr.map(PAGE_COMPONENTS, (component, index) =>
					vstack(
						h,
						{
							gap: "1",
							className: cn("px-2 py-1", index > 0 && "border-t"),
							attributes: [h.Key(component.name), h.Style({ borderColor: PAGE.line })],
						},
						[
							hstack(h, { justify: "between" }, [
								typography(h, { size: "3xs", weight: "medium" }, [component.name]),
								typography(
									h,
									{ size: "4xs", numeric: true, attributes: [h.Style({ color: PAGE.muted })] },
									[component.uptime],
								),
							]),
							hstack(
								h,
								{ align: "stretch", className: "h-2 gap-px" },
								Arr.map(TICKS, (tick) =>
									h.span(
										[
											h.Key(String(tick)),
											h.Class("flex-1 rounded-2xs"),
											h.Style({
												backgroundColor:
													tick === component.degradedTick ? PAGE.degraded : PAGE.ok,
											}),
										],
										[],
									),
								),
							),
						],
					),
				),
			),
		],
	)

/** The builder's form beside its live preview, in miniature. */
const miniBuilder = <M>(h: HtmlBuilder<M>): Html =>
	hstack(h, { gap: "3", align: "stretch", className: "h-full p-3" }, [
		vstack(
			h,
			{ gap: "2.5", className: "w-38 shrink-0" },
			Arr.map(BUILDER_FIELDS, (field) =>
				vstack(h, { gap: "1", attributes: [h.Key(field.label)] }, [
					typography(h, { size: "3xs", tone: "muted" }, [field.label]),
					typography(
						h,
						{
							size: "2xs",
							tone: "foreground",
							truncate: true,
							as: "div",
							className: "rounded-sm border bg-background px-2 py-1",
						},
						[field.value],
					),
				]),
			),
		),
		miniStatusPage(h),
	])

const chip = <M>(h: HtmlBuilder<M>, label: string): Html =>
	badge(h, { variant: "meta", mono: true, attributes: [h.Key(label)] }, [label])

const methodCard = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		isRecommended: boolean
		preview: Html
		title: string
		description: string
		chips: ReadonlyArray<Html>
		action: Html
	}>,
): Html =>
	vstack(
		h,
		{
			className: cn(
				"overflow-hidden rounded-xl border bg-card shadow-raised",
				options.isRecommended && "border-primary",
			),
		},
		[
			options.preview,
			vstack(h, { gap: "3", grow: true, className: "px-5 pt-3 pb-5" }, [
				hstack(h, { gap: "2", wrap: true }, [
					heading(h, { level: 2, variant: "card" }, [options.title]),
					...(options.isRecommended
						? [badge(h, { variant: "live", pill: true }, ["Recommended"])]
						: []),
				]),
				typography(h, { size: "ui", tone: "muted", as: "p", className: "font-prose" }, [
					options.description,
				]),
				hstack(h, { gap: "1.5", wrap: true }, options.chips),
				options.action,
			]),
		],
	)

const OUTCOMES: ReadonlyArray<string> = [
	"Uptime monitors behind every component",
	"A page in your brand",
	"Your own domain, with TLS",
]

/** The two ways to set a page up, and what both end with. */
export const methodChoice = <M>(h: HtmlBuilder<M>): Html =>
	vstack(h, { gap: "5", className: "max-w-5xl" }, [
		typography(h, { size: "sm", tone: "muted", as: "p" }, [
			"Choose who does the setup. Either way, nothing is public until you approve publishing it.",
		]),
		grid(h, { sm: 2, gap: "4" }, [
			methodCard(h, {
				isRecommended: true,
				preview: previewPane(h, [agentTranscript(h)]),
				title: "Let your coding agent set it up",
				description:
					"Paste one prompt into your agent. It reads your repo, proposes monitors, a look and a domain, and asks you before each step.",
				chips: [
					chip(h, "Maple MCP"),
					chip(h, "Terraform"),
					chip(h, "Alchemy"),
					typography(h, { size: "2xs", tone: "muted", mono: true, attributes: [h.Key("caption")] }, [
						"your agent asks which",
					]),
				],
				action: linkButton(h, { href: newStatusPageHref("agent"), className: "mt-auto w-full" }, [
					"Get the prompt",
					icon(h, "ArrowRightIcon"),
				]),
			}),
			methodCard(h, {
				isRecommended: false,
				preview: previewPane(h, [miniBuilder(h)]),
				title: "Set it up in the dashboard",
				description:
					"Name the page, pick components from your monitors or add URLs to check, choose a theme and a domain. A live preview updates as you type.",
				chips: [chip(h, "About 5 minutes"), chip(h, "No code")],
				action: linkButton(
					h,
					{ href: newStatusPageHref("manual"), variant: "outline", className: "mt-auto w-full" },
					["Open the builder"],
				),
			}),
		]),
		hstack(h, { gap: "6", wrap: true, className: "gap-y-3 border-t pt-5 font-mono text-xs" }, [
			typography(h, { tone: "muted" }, ["Both paths end with"]),
			...Arr.map(OUTCOMES, (outcome) =>
				hstack(h, { gap: "2", attributes: [h.Key(outcome)] }, [
					statusDot(h, { tone: "ok" }),
					typography(h, { tone: "foreground" }, [outcome]),
				]),
			),
		]),
	])
