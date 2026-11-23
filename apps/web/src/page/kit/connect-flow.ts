import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { crossfade } from "@maple/views/ui/crossfade"
import { eyebrow, eyebrowVariants } from "@maple/views/ui/eyebrow"
import { icon, type IconName } from "@maple/views/ui/icon"
import { spinner } from "@maple/views/ui/spinner"
import { Array as Arr } from "effect"

// The parts every source's connect flow is built from: the step card, its status row, the rail
// beside it and the Go live checklist. `/sources/new` frames them; each source fills them in.

type Children = ReadonlyArray<Html | string>

/** The step's two columns: the step itself, and the rail of what Maple reads beside it. */
export const flowColumns = <M>(h: HtmlBuilder<M>, main: ReadonlyArray<Html>, rail: Html | null): Html =>
	h.div(
		[h.Class("grid grid-cols-1 items-start gap-6 @4xl/page:grid-cols-[minmax(0,1fr)_17.5rem]")],
		[h.div([h.Class("flex min-w-0 flex-col gap-4")], main), ...(rail === null ? [] : [rail])],
	)

export type StepCardOptions = Readonly<{
	icon?: IconName
	title: string
	/** A quiet note at the header's end: "encrypted at rest", "read-only". */
	note?: string
}>

/** The step's one card: a titled body. */
export const stepCard = <M>(h: HtmlBuilder<M>, options: StepCardOptions, children: Children): Html =>
	h.section(
		[h.Class("flex flex-col gap-5 rounded-md border border-border bg-card p-5")],
		[
			h.header(
				[h.Class("flex flex-wrap items-center justify-between gap-2")],
				[
					h.h2(
						[h.Class("inline-flex items-center gap-2.5 text-sm font-medium")],
						[
							...(options.icon === undefined ? [] : [icon(h, options.icon, { size: 16 })]),
							options.title,
						],
					),
					...(options.note === undefined
						? []
						: [
								h.span(
									[
										h.Class(
											"inline-flex items-center gap-1.5 text-xs text-muted-foreground",
										),
									],
									[icon(h, "ShieldCheckIcon", { size: 12 }), options.note],
								),
							]),
				],
			),
			...children,
		],
	)

export type ChoiceTileOptions<M> = Readonly<{
	title: string
	description: string
	/** "Recommended", "Broader". */
	tag?: string
	isSelected?: boolean
	onSelect?: M
}>

/** Two or three side by side: which kind of token, which way to run a template. */
export const choiceTiles = <M>(h: HtmlBuilder<M>, tiles: ReadonlyArray<ChoiceTileOptions<M>>): Html =>
	h.div(
		[h.Class("grid grid-cols-1 gap-3 @2xl/page:grid-cols-2")],
		Arr.map(tiles, (tile) => {
			const body = [
				h.span(
					[h.Class("flex items-center justify-between gap-2")],
					[
						h.span([h.Class("text-sm font-medium")], [tile.title]),
						...(tile.tag === undefined
							? []
							: [
									h.span(
										[h.Class(cn(eyebrowVariants({ variant: "mono" }), "text-primary"))],
										[tile.tag],
									),
								]),
					],
				),
				h.span([h.Class("text-xs text-muted-foreground")], [tile.description]),
			]
			const className = cn(
				"flex flex-col gap-1.5 rounded-md border p-3.5 text-left",
				tile.isSelected === true ? "border-primary bg-primary-a1" : "border-border",
			)
			return tile.onSelect === undefined
				? h.div([h.Class(className)], body)
				: h.button(
						[
							h.Type("button"),
							h.Class(cn(className, "hover:border-border-strong active:border-border-strong")),
							h.AriaPressed(tile.isSelected === true ? "true" : "false"),
							h.OnClick(tile.onSelect),
						],
						body,
					)
		}),
	)

export type StatusTone = "idle" | "working" | "ok" | "error"

const STATUS_ICON = {
	idle: { name: "ClockIcon", className: "text-muted-foreground" },
	ok: { name: "CircleCheckIcon", className: "text-severity-info" },
	error: { name: "CircleWarningIcon", className: "text-severity-error" },
} satisfies Record<Exclude<StatusTone, "working">, { name: IconName; className: string }>

// "Waiting" turning into "found" cross-fades the spinner into the result glyph instead of swapping it.
const statusGlyph = <M>(h: HtmlBuilder<M>, tone: StatusTone): Html => {
	const result = tone === "working" ? STATUS_ICON.ok : STATUS_ICON[tone]
	return crossfade(h, { variant: "glyph", className: "size-3.5" }, [
		{ isShown: tone === "working", children: [spinner(h, "text-primary", 14)] },
		{
			isShown: tone !== "working",
			children: [icon(h, result.name, { size: 14, className: result.className })],
		},
	])
}

export type StatusRowOptions = Readonly<{
	tone: StatusTone
	text: string
	/** At the row's end: "3s", "just now". */
	meta?: Html | string
}>

/**
 * Under the step card: what Maple is waiting for, or what it found. It completes the step on its
 * own, so no step has a separate Test button. `children` sit under the text (found resources, a retry).
 */
export const statusRow = <M>(h: HtmlBuilder<M>, options: StatusRowOptions, children: Children = []): Html =>
	h.div(
		[
			h.Class(
				cn(
					"flex items-start gap-3 rounded-md border bg-card p-4",
					options.tone === "error" ? "border-severity-error-a4" : "border-border",
				),
			),
			h.Role("status"),
			h.AriaLive("polite"),
		],
		[
			h.span([h.Class("mt-0.5 shrink-0")], [statusGlyph(h, options.tone)]),
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-col gap-2")],
				[h.p([h.Class("text-sm [overflow-wrap:anywhere]")], [options.text]), ...children],
			),
			...(options.meta === undefined
				? []
				: [h.span([h.Class("shrink-0 text-xs text-muted-foreground tabular-nums")], [options.meta])]),
		],
	)

/** Small labelled chips under a status row: the projects, zones or targets it found. */
export const foundChips = <M>(
	h: HtmlBuilder<M>,
	chips: ReadonlyArray<Readonly<{ label: string; detail?: string }>>,
): Html =>
	h.ul(
		[h.Class("flex flex-wrap gap-1.5")],
		Arr.map(chips, (chip) =>
			h.li(
				[
					h.Class(
						"rounded-sm border border-border-subtle bg-surface-sunken px-1.5 py-0.5 font-mono text-2xs",
					),
				],
				[
					chip.label,
					...(chip.detail === undefined
						? []
						: [h.span([h.Class("text-muted-foreground")], [" ", chip.detail])]),
				],
			),
		),
	)

export type RailItem = Readonly<{ icon: IconName; title: string; detail: string }>

export type RailOptions = Readonly<{
	/** "What Maple reads", "Where it shows up". */
	eyebrow: string
	items: ReadonlyArray<RailItem>
	/** Read-only, and how to revoke. */
	trust?: string
	/** "Takes about 1 minute". */
	timeNote?: string
	docs?: Readonly<{ label: string; href: string }> | null
}>

/** Beside the step: what Maple reads, how to revoke it, and how long it takes. */
export const flowRail = <M>(h: HtmlBuilder<M>, options: RailOptions): Html =>
	h.aside(
		[h.Class("flex flex-col gap-3")],
		[
			h.div(
				[h.Class("flex flex-col gap-4 rounded-md border border-border bg-card p-4")],
				[
					eyebrow(h, { variant: "label" }, [options.eyebrow]),
					h.ul(
						[h.Class("flex flex-col gap-3.5")],
						Arr.map(options.items, (item) =>
							h.li(
								[h.Class("flex gap-2.5")],
								[
									icon(h, item.icon, {
										size: 14,
										className: "mt-0.5 shrink-0 text-muted-foreground",
									}),
									h.div(
										[h.Class("flex flex-col gap-0.5")],
										[
											h.span([h.Class("text-sm")], [item.title]),
											h.span([h.Class("text-xs text-muted-foreground")], [item.detail]),
										],
									),
								],
							),
						),
					),
					...(options.trust === undefined
						? []
						: [
								h.p(
									[
										h.Class(
											"flex gap-2.5 border-t border-border pt-3.5 text-xs text-muted-foreground",
										),
									],
									[
										icon(h, "ShieldCheckIcon", {
											size: 14,
											className: "mt-px shrink-0 text-severity-info",
										}),
										options.trust,
									],
								),
							]),
				],
			),
			...(options.timeNote === undefined && options.docs == null
				? []
				: [
						h.div(
							[
								h.Class(
									"flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground",
								),
							],
							[
								h.span([], [options.timeNote ?? ""]),
								...(options.docs == null
									? []
									: [
											h.a(
												[
													h.Href(options.docs.href),
													h.Target("_blank"),
													h.Rel("noreferrer"),
													h.Class(
														"text-foreground hover:underline active:underline",
													),
												],
												[options.docs.label],
											),
										]),
							],
						),
					]),
		],
	)

/** A switch card's header note: where its switches live once the flow is done. */
export const CHANGE_LATER_NOTE = "Change later on the Connection tab"

/** The rail's last item on every source: where its settings live once the flow is done. */
export const connectionTabItem = (detail: string): RailItem => ({
	icon: "GearIcon",
	title: "Connection tab",
	detail: `On the source page: ${detail}`,
})

/** `working` spins; `active` is its still glyph, for a list re-read on a poll (a run's stages). */
export type CheckState = "done" | "working" | "active" | "pending" | "waiting" | "skipped" | "failed"

export type CheckRow = Readonly<{
	state: CheckState
	title: string
	detail?: Html | string | null
	meta?: Html | string | null
	/** Under the detail: a progress bar, per-signal marks, a fix. */
	extra?: Html
}>

const CHECK_ICON = {
	done: { name: "CircleCheckIcon", className: "text-severity-info" },
	active: { name: "ArrowRightIcon", className: "text-primary" },
	pending: { name: "CircleIcon", className: "text-muted-foreground" },
	waiting: { name: "ClockIcon", className: "text-muted-foreground" },
	skipped: { name: "MinusIcon", className: "text-muted-foreground" },
	failed: { name: "CircleWarningIcon", className: "text-severity-error" },
} satisfies Record<Exclude<CheckState, "working">, { name: IconName; className: string }>

const checkGlyph = <M>(h: HtmlBuilder<M>, state: CheckState): Html =>
	state === "working"
		? spinner(h, "text-primary", 16)
		: icon(h, CHECK_ICON[state].name, { size: 16, className: CHECK_ICON[state].className })

/** A row's state as words: the glyph is hidden from assistive technology, so this is what it reads. */
const CHECK_STATE_LABEL = {
	done: "done",
	working: "in progress",
	active: "in progress",
	pending: "not started",
	waiting: "waiting",
	skipped: "skipped",
	failed: "needs attention",
} satisfies Record<CheckState, string>

/** What a screen reader hears when polling moves a row: counts only, so ticking times stay quiet. */
const checklistSummary = (rows: ReadonlyArray<CheckRow>): string => {
	const done = Arr.filter(rows, (row) => row.state === "done").length
	const failed = Arr.filter(rows, (row) => row.state === "failed").length
	return `${done} of ${rows.length} checks done${failed === 0 ? "" : `, ${failed} ${failed === 1 ? "needs" : "need"} attention`}.`
}

export type LiveChecklistOptions = Readonly<{
	title?: string
	meta?: Html | string
	/** A line under the title: where the whole list stands. */
	summary?: Html | string
	rows: ReadonlyArray<CheckRow>
	/** The source exists, so leaving is safe: "Saved as a source. Safe to leave; sync keeps running." */
	saved?: string
}>

/** Go live's one card: access works, resources found, first data, and that leaving is safe. */
export const liveChecklist = <M>(h: HtmlBuilder<M>, options: LiveChecklistOptions): Html =>
	h.section(
		[
			h.Class("flex flex-col rounded-md border border-border bg-card"),
			h.AriaLabel(options.title ?? "Going live"),
		],
		[
			h.header(
				[h.Class("flex items-center justify-between gap-2 px-5 pt-4 pb-2")],
				[
					h.h2([h.Class("text-sm font-medium")], [options.title ?? "Going live"]),
					...(options.meta === undefined
						? []
						: [h.span([h.Class("text-xs text-muted-foreground")], [options.meta])]),
				],
			),
			...(options.summary === undefined
				? []
				: [
						// Announced too: a summary can change with no row changing (a run that expired unreported).
						h.p(
							[h.Class("px-5 pb-2 text-sm text-muted-foreground"), h.AriaLive("polite")],
							[options.summary],
						),
					]),
			h.p(
				[h.Class("sr-only"), h.AriaLive("polite"), h.AriaAtomic(true)],
				[checklistSummary(options.rows)],
			),
			h.ol(
				[h.Class("flex flex-col")],
				Arr.map(options.rows, (row) =>
					h.li(
						[
							h.Class("flex gap-3 border-t border-border-subtle px-5 py-3 first:border-t-0"),
							h.DataAttribute("state", row.state),
						],
						[
							h.span([h.Class("mt-0.5 shrink-0")], [checkGlyph(h, row.state)]),
							h.div(
								[h.Class("flex min-w-0 flex-1 flex-col gap-1")],
								[
									h.span(
										[
											h.Class(
												cn(
													"text-sm",
													row.state !== "done" &&
														row.state !== "working" &&
														row.state !== "active" &&
														row.state !== "failed" &&
														"text-muted-foreground",
												),
											),
										],
										[
											row.title,
											h.span(
												[h.Class("sr-only")],
												[`, ${CHECK_STATE_LABEL[row.state]}`],
											),
										],
									),
									...(row.detail == null
										? []
										: [
												h.span(
													[
														h.Class(
															"text-xs text-muted-foreground [overflow-wrap:anywhere]",
														),
													],
													[row.detail],
												),
											]),
									...(row.extra === undefined ? [] : [row.extra]),
								],
							),
							...(row.meta == null
								? []
								: [
										h.span(
											[h.Class("shrink-0 text-xs text-muted-foreground tabular-nums")],
											[row.meta],
										),
									]),
						],
					),
				),
			),
			...(options.saved === undefined
				? []
				: [
						h.p(
							[
								h.Class(
									"flex items-center gap-2 border-t border-border-subtle px-5 py-3 text-xs text-muted-foreground",
								),
							],
							[
								icon(h, "ShieldCheckIcon", {
									size: 14,
									className: "shrink-0 text-severity-info",
								}),
								options.saved,
							],
						),
					]),
		],
	)

/** A labelled field's "Where to find this" link, at the label's end. */
export const whereToFind = <M>(h: HtmlBuilder<M>, label: string, href: string): Html =>
	h.a(
		[
			h.Href(href),
			h.Target("_blank"),
			h.Rel("noreferrer"),
			h.Class(
				"inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground active:text-foreground",
			),
		],
		[label, icon(h, "ExternalLinkIcon", { size: 12 })],
	)
