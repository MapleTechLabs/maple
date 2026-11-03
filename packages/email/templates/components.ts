/**
 * The email building blocks, shared by all three templates.
 *
 * A component's text and colours default to `[[token]]` placeholders, so
 * rendering it with no arguments yields the compiled shape the runtime fills
 * in. `[[#name]]` marks a hole for another fragment. Every class compiles to
 * an inline style at build time (`scripts/inline-tailwind.ts`).
 */
import type { Html } from "foldkit/html"
import { cellsSlot, type Child, type H, MARK_SRC, rowsSlot } from "./render"
import { Array as Arr, Record as Rec, String as Str } from "effect"

const attributes = (h: H, values: Readonly<Record<string, string>>) =>
	Arr.map(Rec.toEntries(values), ([key, value]) => h.Attribute(key, value))

/** react-email's `<Section>`/`<Container>` table attributes. */
const presentation = (h: H) =>
	attributes(h, {
		align: "center",
		width: "100%",
		border: "0",
		cellpadding: "0",
		cellspacing: "0",
		role: "presentation",
	})

const iconImage = (h: H, size: number, extraStyle = "") =>
	h.img(
		attributes(h, {
			src: "[[icon]]",
			width: String(size),
			height: String(size),
			alt: "",
			style: `display:block;border:0;width:${size}px;height:${size}px${extraStyle}`,
		}),
	)

const table = (h: H, className: string, rows: ReadonlyArray<Child>) =>
	h.table([h.Class(className)], [h.tbody([], rows)])

/** The header cells of the services, breakdown and rank tables. */
const headerCell = (h: H, align: "left" | "right", label: string, extraClass = "") =>
	h.th(
		[
			h.Class(
				`${extraClass}px-3 py-2 text-${align} font-mono text-[10px] font-medium uppercase tracking-widest text-maple-fg-dim`,
			),
			h.Attribute("style", "border-bottom:1px solid #302b26"),
		],
		[label],
	)

/** A full-width presentational table wrapper. */
export const section = (h: H, className: string, children: ReadonlyArray<Child>): Html =>
	h.table([...presentation(h), h.Class(className)], [h.tbody([], [h.tr([], [h.td([], children)])])])

/** The small uppercase caption above each block ("Service Health", "Ingestion"). */
export const sectionLabel = (h: H, children: ReadonlyArray<Child>, extraClass = ""): Html =>
	h.p(
		[
			h.Class(
				Str.trim(
					`m-0 font-mono text-[10px] uppercase leading-[24px] tracking-widest text-maple-fg-dim ${extraClass}`,
				),
			),
		],
		children,
	)

/** Rounded, bordered surface that clips its rows (service table, error list). */
export const panel = (h: H, children: ReadonlyArray<Child>, extraClass = ""): Html =>
	h.div(
		[
			h.Class(
				Str.trim(
					`overflow-hidden rounded-lg border border-solid border-maple-border-subtle bg-maple-card ${extraClass}`,
				),
			),
		],
		children,
	)

/** Solid card used for the summary metrics and the ingestion counters. */
const tile = (h: H, className: string, children: ReadonlyArray<Child>): Html =>
	h.div([h.Class(`rounded-lg bg-maple-card ${className}`)], children)

/** Bare arrow + magnitude line, tinted by direction (service rows, ingestion). */
const trendText = (h: H, extraClass = ""): Html =>
	h.p(
		[
			h.Class(Str.trim(`m-0 font-mono text-[10px] leading-tight ${extraClass}`)),
			h.Attribute("style", "color:[[color]]"),
		],
		["[[arrow]] [[value]]"],
	)

/**
 * Page chrome: hidden preheader, then the body/container table sandwich that
 * react-email's Body/Container expanded to.
 */
export const shell = (h: H, children: ReadonlyArray<Child>): ReadonlyArray<Child> => [
	h.div(
		[
			h.Attribute(
				"style",
				"display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0",
			),
		],
		["[[previewText]]", h.div([], ["[[#preheaderPad]]"])],
	),
	h.table(
		attributes(h, {
			border: "0",
			width: "100%",
			cellpadding: "0",
			cellspacing: "0",
			role: "presentation",
			align: "center",
		}),
		[
			h.tbody(
				[],
				[
					h.tr(
						[],
						[
							h.td(
								[h.Class("m-0 bg-maple-bg px-4 py-10 font-mono")],
								[
									h.table(
										[
											...presentation(h),
											h.Class(
												"mx-auto max-w-[560px] overflow-hidden rounded-xl border border-solid border-maple-border bg-maple-surface",
											),
										],
										[
											h.tbody(
												[],
												[
													h.tr(
														[h.Attribute("style", "width:100%")],
														[h.td([], children)],
													),
												],
											),
										],
									),
								],
							),
						],
					),
				],
			),
		],
	),
]

/**
 * The Maple tree mark beside the title. A hosted PNG rather than inline SVG:
 * Gmail and Outlook strip `<svg>`. The style is react-email's `<Img>` reset.
 */
export const header = (h: H, title: string, subtitle: ReadonlyArray<Child>): Html =>
	section(h, "px-6 pb-5 pt-6", [
		table(h, "w-full", [
			h.tr(
				[],
				[
					h.td(
						[h.Class("w-[36px] pr-3 align-middle")],
						[
							h.img(
								attributes(h, {
									alt: "Maple",
									height: "32",
									src: MARK_SRC,
									style: "display:block;outline:none;border:none;text-decoration:none",
									width: "32",
								}),
							),
						],
					),
					h.td(
						[h.Class("align-middle")],
						[
							h.p([h.Class("m-0 font-mono text-base font-semibold text-maple-fg")], [title]),
							h.p([h.Class("m-0 mt-0.5 font-mono text-xs text-maple-fg-muted")], subtitle),
						],
					),
				],
			),
		]),
	])

/** Hairline rule that fades from an accent colour into the border colour. */
export const divider = (h: H, accent = "#e8872a"): Html =>
	h.div(
		[
			h.Class("mx-6 h-px bg-maple-border"),
			h.Attribute("style", `background-image:linear-gradient(to right, ${accent}, #3a342e 40%)`),
		],
		[],
	)

/** Full-width button link. */
export const cta = (h: H, href: string, label: string): Html =>
	h.a(
		[
			...attributes(h, { href, target: "_blank" }),
			h.Class(
				"block rounded-lg bg-maple-orange px-6 py-3 text-center font-mono text-sm font-semibold text-white no-underline",
			),
		],
		[label],
	)

/** Centred fine print at the bottom of every email. */
export const footer = (h: H, children: ReadonlyArray<Child>): Html =>
	section(h, "px-6 pb-6 pt-3", [
		h.p([h.Class("m-0 text-center font-mono text-[11px] leading-[24px] text-maple-fg-dim")], children),
	])

/** "Powered by Maple · <reason> Unsubscribe", the digests' footer copy. */
export const digestFooter = (h: H, reason: string): Html =>
	footer(h, [
		"Powered by ",
		h.a(
			[
				...attributes(h, { href: "[[baseUrl]]", target: "_blank" }),
				h.Class("text-maple-fg-muted no-underline"),
			],
			["Maple"],
		),
		` · ${reason} `,
		h.a(
			[
				...attributes(h, { href: "[[unsubscribeUrl]]", target: "_blank" }),
				h.Class("text-maple-fg-muted underline"),
			],
			["Unsubscribe"],
		),
	])

/** Two rows of `[[#summaryRowOne]]` / `[[#summaryRowTwo]]` metric cards. */
export const summaryGrid = (h: H): Html =>
	section(h, "px-5 pt-4", [
		table(h, "w-full border-collapse", [
			h.tr([], [cellsSlot(h, "summaryRowOne")]),
			h.tr([], [cellsSlot(h, "summaryRowTwo")]),
		]),
	])

// ---------------------------------------------------------------------------
// Fragments: each renders standalone and is spliced into a page slot.
// ---------------------------------------------------------------------------

/** Week-over-week delta chip. Colours are decided at render time. */
export const deltaPill = (h: H): Html =>
	h.span(
		[
			h.Attribute(
				"style",
				"display:inline-block;background-color:[[bg]];color:[[color]];border-radius:5px;padding:2px 6px;font-size:11px;font-weight:600;line-height:14px",
			),
		],
		["[[arrow]] [[value]]"],
	)

/** Health verdict banner. One compiled fragment serves every level. */
export const statusBanner = (h: H): Html =>
	section(h, "px-5 pt-5", [
		h.div(
			[
				h.Attribute(
					"style",
					"border-left:3px solid [[accent]];background-color:[[bannerBg]];border-top-right-radius:8px;border-bottom-right-radius:8px;padding:14px 16px",
				),
			],
			[
				h.span(
					[
						h.Attribute(
							"style",
							"display:inline-block;background-color:[[pillBg]];color:[[pillFg]];border-radius:5px;padding:3px 8px;font-size:10px;font-weight:700;letter-spacing:0.12em",
						),
					],
					["[[label]]"],
				),
				h.p(
					[h.Class("m-0 mt-2.5 font-mono text-[14px] font-medium leading-snug text-maple-fg")],
					["[[headline]]"],
				),
				"[[#biggestMover]]",
			],
		),
	])

/** Optional second line under the status headline. */
export const biggestMover = (h: H): Html =>
	h.p([h.Class("m-0 mt-1 font-mono text-[12px] leading-snug text-maple-fg-muted")], ["[[text]]"])

/** One of the four headline metrics. */
export const summaryCard = (h: H): Html =>
	h.td(
		[h.Class("w-1/2 p-1")],
		[
			tile(h, "px-4 py-3.5", [
				sectionLabel(h, ["[[label]]"], "mb-1.5"),
				h.p(
					[h.Class("m-0 mb-2 font-mono text-[22px] font-semibold leading-none text-maple-fg")],
					["[[value]]"],
				),
				"[[#deltaPill]]",
			]),
		],
	)

/** One headline stat with its icon, and the week-over-week pill spelled out. */
export const statCard = (h: H): Html =>
	h.td([h.Class("w-1/2 p-1")], [tile(h, "px-4 py-3.5", statCardBody(h))])

const statCardBody = (h: H): ReadonlyArray<Child> => [
	table(h, "mb-1.5", [
		h.tr(
			[],
			[
				h.td([h.Class("w-[14px] pr-1.5 align-middle")], [iconImage(h, 14)]),
				h.td([h.Class("align-middle")], [sectionLabel(h, ["[[label]]"])]),
			],
		),
	]),
	h.p([h.Class("m-0 mb-2 font-mono text-[22px] font-semibold leading-none text-maple-fg")], ["[[value]]"]),
	h.p(
		[h.Class("m-0 font-mono text-[10px] leading-[16px] text-maple-fg-dim")],
		["[[#deltaPill]] vs last week"],
	),
]

/** Half of the AI block: a total with its trend, then the top few by name. */
export const aiColumn = (h: H): Html =>
	h.td(
		[h.Class("w-1/2 p-1 align-top")],
		[
			tile(h, "px-4 py-3.5", [
				...statCardBody(h),
				h.p(
					[h.Class("m-0 mb-1 mt-3 font-mono text-[10px] leading-[16px] text-maple-fg-muted")],
					["[[hint]]"],
				),
				table(h, "w-full border-collapse", [rowsSlot(h, "rows")]),
			]),
		],
	)

/** AI traffic block: section head, then assistants and crawlers side by side. */
export const aiSection = (h: H): ReadonlyArray<Child> => [
	section(h, "px-6 pt-6", ["[[#head]]"]),
	section(h, "px-5", [table(h, "w-full border-collapse", [h.tr([], [cellsSlot(h, "aiColumns")])])]),
	"[[#aiQuiet]]",
]

/** 7-day request trend: header row with the total, then the bar chart. */
export const sparklineSection = (h: H): Html =>
	section(h, "px-6 pt-5", [
		table(h, "w-full", [
			h.tr(
				[],
				[
					h.td([h.Class("align-middle")], [sectionLabel(h, ["Requests · 7-day trend"])]),
					h.td(
						[h.Class("text-right align-middle")],
						[
							h.p(
								[
									h.Class(
										"m-0 font-mono text-[13px] font-semibold leading-[24px] text-maple-fg",
									),
								],
								[
									"[[totalRequests]] ",
									h.span([h.Attribute("style", "font-weight:400")], ["[[#deltaPill]]"]),
								],
							),
						],
					),
				],
			),
		]),
		h.div(
			[
				h.Class(
					"mt-2 rounded-lg border border-solid border-maple-border-subtle bg-maple-card px-3 pb-2 pt-3",
				),
			],
			[
				h.table(
					[h.Class("w-full"), h.Attribute("style", "border-collapse:collapse")],
					[
						h.tbody(
							[],
							[h.tr([], [cellsSlot(h, "sparkBars")]), h.tr([], [cellsSlot(h, "sparkLabels")])],
						),
					],
				),
			],
		),
	])

/** One day's column; both segments are separate fragments so either can drop out. */
export const sparkBar = (h: H): Html =>
	h.td(
		[h.Attribute("style", "height: 52px; vertical-align: bottom; padding: 0 3px")],
		["[[#barOk]][[#barErr]]"],
	)

/** Successful-request portion of a sparkline bar. */
export const barOk = (h: H): Html =>
	h.div(
		[
			h.Attribute(
				"style",
				"height:[[h]]px;background-color:#e8872a;border-top-left-radius:3px;border-top-right-radius:3px;border-bottom-left-radius:[[radiusBottom]];border-bottom-right-radius:[[radiusBottom]]",
			),
		],
		[],
	)

/** Error portion of a sparkline bar, stacked under the success portion. */
export const barErr = (h: H): Html =>
	h.div(
		[
			h.Attribute(
				"style",
				"height:[[h]]px;background-color:#e85d4a;border-top-left-radius:[[radiusTop]];border-top-right-radius:[[radiusTop]];border-bottom-left-radius:3px;border-bottom-right-radius:3px",
			),
		],
		[],
	)

/** Weekday initial under a sparkline column. */
export const sparkLabel = (h: H): Html =>
	h.td(
		[h.Attribute("style", "text-align: center; padding-top: 6px")],
		[h.p([h.Class("m-0 font-mono text-[9px] leading-[24px] text-maple-fg-dim")], ["[[label]]"])],
	)

/** "By environment" / "By namespace" breakdown table. */
export const breakdownTable = (h: H): Html =>
	section(h, "px-6 pt-5", [
		sectionLabel(h, ["[[heading]]"], "mb-3"),
		panel(h, [
			h.table(
				[h.Class("w-full border-collapse")],
				[
					h.thead(
						[],
						[
							h.tr(
								[],
								[
									headerCell(h, "left", "Name"),
									headerCell(h, "right", "Reqs"),
									headerCell(h, "right", "Err%"),
								],
							),
						],
					),
					h.tbody([], [rowsSlot(h, "breakdownRows")]),
				],
			),
		]),
	])

/** One environment or namespace in the breakdown table. */
export const breakdownRow = (h: H): Html => {
	const cell = (extraClass: string, children: ReadonlyArray<Child>) =>
		h.td(
			[
				h.Class(`px-3 py-2 ${extraClass}align-middle`),
				h.Attribute("style", "border-bottom:[[rowBorder]]"),
			],
			children,
		)
	const text = "m-0 font-mono text-[12px] leading-[20px]"
	return h.tr(
		[],
		[
			cell("", [h.p([h.Class(`${text} text-maple-fg`)], ["[[label]]"])]),
			cell("text-right ", [
				h.p([h.Class(`${text} text-maple-fg-muted`)], ["[[requests]]"]),
				"[[#breakdownDelta]]",
			]),
			cell("text-right ", [
				h.p([h.Class(text), h.Attribute("style", "color:[[errRateColor]]")], ["[[errRate]]"]),
			]),
		],
	)
}

/** Service health table. Header cells carry their border inline: `border-b`
    sets a width but no style once preflight is off. */
export const servicesSection = (h: H): Html =>
	section(h, "px-6 pt-5", [
		sectionLabel(h, ["Service Health"], "mb-3"),
		panel(h, [
			h.table(
				[h.Class("w-full border-collapse")],
				[
					h.thead(
						[],
						[
							h.tr(
								[],
								[
									headerCell(h, "left", "Service"),
									headerCell(h, "right", "Reqs"),
									headerCell(h, "right", "Err%"),
									headerCell(h, "right", "P95"),
								],
							),
						],
					),
					h.tbody([], [rowsSlot(h, "serviceRows")]),
				],
			),
		]),
	])

/** Sub-header row inside the service-health table, one per environment. */
export const envGroupHeader = (h: H): Html =>
	h.tr(
		[],
		[
			h.td(
				[h.Attribute("colspan", "2"), h.Class("px-3 pb-1.5 pt-3 align-middle")],
				[
					h.p(
						[
							h.Class(
								"m-0 font-mono text-[10px] font-semibold uppercase leading-[14px] tracking-widest text-maple-fg-muted",
							),
						],
						["[[environment]]"],
					),
				],
			),
			h.td(
				[h.Attribute("colspan", "2"), h.Class("px-3 pb-1.5 pt-3 text-right align-middle")],
				[
					h.p(
						[h.Class("m-0 font-mono text-[10px] leading-[14px] text-maple-fg-dim")],
						["[[requests]] reqs"],
					),
					"[[#groupDelta]]",
				],
			),
		],
	)

/** One service in the health table. `rowBorder` is `none` on the last row. */
export const serviceRow = (h: H): Html => {
	const cell = (children: ReadonlyArray<Child>) =>
		h.td(
			[
				h.Class("px-3 py-2.5 text-right align-middle"),
				h.Attribute("style", "border-bottom:[[rowBorder]]"),
			],
			children,
		)
	const figure = (className: string, style: string | undefined, value: string) =>
		h.p(
			[
				h.Class(`m-0 font-mono text-[13px] leading-[24px]${className}`),
				...(style === undefined ? [] : [h.Attribute("style", style)]),
			],
			[value],
		)
	return h.tr(
		[],
		[
			h.td(
				[h.Class("px-3 py-2.5"), h.Attribute("style", "border-bottom:[[rowBorder]]")],
				[
					h.a(
						[
							...attributes(h, { href: "[[url]]", target: "_blank" }),
							h.Class("font-mono text-[13px] font-medium text-maple-fg no-underline"),
						],
						[
							h.span(
								[h.Attribute("style", "color:[[dotColor]];font-size:9px;margin-right:6px")],
								["●"],
							),
							"[[name]]",
						],
					),
					"[[#serviceScope]]",
				],
			),
			cell([figure(" text-maple-fg-muted", undefined, "[[requests]]"), "[[#serviceRequestsDelta]]"]),
			cell([figure("", "color:[[errRateColor]]", "[[errRate]]")]),
			cell([figure(" text-maple-fg-muted", undefined, "[[p95]]")]),
		],
	)
}

/** Week-over-week traffic line under a service's request count. */
export const serviceDelta = (h: H): Html => trendText(h)

/** The same trend line, spaced away from the ingestion value above it. */
export const ingestionDelta = (h: H): Html => trendText(h, "mt-1")

/** Environment / namespace tag beside a service name. */
export const scopeChip = (h: H): Html =>
	h.span(
		[
			h.Attribute(
				"style",
				"display:inline-block;background-color:rgba(138,127,114,0.14);color:#8a7f72;border-radius:4px;padding:1px 5px;font-size:9px;font-weight:600;letter-spacing:0.04em;margin-left:6px;vertical-align:middle",
			),
		],
		["[[label]]"],
	)

/** Names the slice a scoped digest covers, under the header subtitle. */
export const scopeLine = (h: H): Html =>
	h.span(
		[
			h.Attribute(
				"style",
				"display:inline-block;background-color:rgba(232,135,42,0.14);color:#e8872a;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:600;margin-left:6px;vertical-align:middle",
			),
		],
		["[[text]]"],
	)

/** Top errors block: caption + "View all" link, then the ranked list. */
export const errorsSection = (h: H): Html =>
	section(h, "px-6 pt-5", [
		table(h, "w-full", [
			h.tr(
				[],
				[
					h.td([h.Class("align-middle")], [sectionLabel(h, ["Top Errors"])]),
					h.td(
						[h.Class("text-right align-middle")],
						[
							h.a(
								[
									...attributes(h, { href: "[[errorsUrl]]", target: "_blank" }),
									h.Class(
										"font-mono text-[10px] uppercase tracking-widest text-maple-orange no-underline",
									),
								],
								["View all →"],
							),
						],
					),
				],
			),
		]),
		panel(h, ["[[#errorRows]]"], "mt-2"),
	])

/** One ranked error. The NEW badge butts directly against the message. */
export const errorRow = (h: H): Html =>
	h.div(
		[h.Class("px-3 py-2.5"), h.Attribute("style", "border-bottom:[[rowBorder]]")],
		[
			table(h, "w-full", [
				h.tr(
					[],
					[
						h.td(
							[h.Class("w-[20px] align-top")],
							[
								h.p(
									[h.Class("m-0 font-mono text-[13px] leading-[24px] text-maple-fg-dim")],
									["[[index]]."],
								),
							],
						),
						h.td(
							[h.Class("align-top")],
							[
								h.p(
									[h.Class("m-0 font-mono text-[13px] leading-snug text-maple-fg")],
									["[[#newBadge]][[message]]"],
								),
								"[[#affectedServices]]",
							],
						),
						h.td(
							[h.Class("w-[56px] text-right align-top")],
							[
								h.p(
									[
										h.Class(
											"m-0 font-mono text-[13px] font-medium leading-[24px] text-maple-red",
										),
									],
									["[[count]]×"],
								),
							],
						),
					],
				),
			]),
		],
	)

/** Marks an error that first appeared inside the digest window. */
export const newBadge = (h: H): Html =>
	h.span(
		[
			h.Attribute(
				"style",
				"display:inline-block;background-color:rgba(232,93,74,0.16);color:#e85d4a;border-radius:4px;padding:1px 5px;font-size:9px;font-weight:700;letter-spacing:0.08em;margin-right:6px;vertical-align:middle",
			),
		],
		["NEW"],
	)

/** Optional "N services affected" line under an error message. */
export const affectedServices = (h: H): Html =>
	h.p([h.Class("m-0 mt-0.5 font-mono text-[10px] leading-tight text-maple-fg-dim")], ["[[text]]"])

/** One ingestion counter (logs / traces / metrics / total bytes). */
export const ingestionCell = (h: H): Html =>
	h.td(
		[h.Class("w-1/4 p-1")],
		[
			tile(h, "px-3 py-2.5 text-center", [
				sectionLabel(h, ["[[label]]"], "mb-1"),
				h.p([h.Class("m-0 font-mono text-sm font-semibold text-maple-fg")], ["[[value]]"]),
				"[[#ingestionDelta]]",
			]),
		],
	)

/** Section title with its icon, a one-line hint, and a link. */
export const sectionHead = (h: H): ReadonlyArray<Child> => [
	table(h, "w-full", [
		h.tr(
			[],
			[
				h.td([h.Class("w-[16px] pr-2 align-middle")], [iconImage(h, 16)]),
				h.td(
					[h.Class("align-middle")],
					[
						h.p(
							[h.Class("m-0 font-mono text-[13px] font-semibold leading-[20px] text-maple-fg")],
							["[[title]]"],
						),
					],
				),
				h.td(
					[h.Class("text-right align-middle")],
					[
						h.a(
							[
								...attributes(h, { href: "[[href]]", target: "_blank" }),
								h.Class(
									"font-mono text-[10px] uppercase tracking-widest text-maple-orange no-underline",
								),
							],
							["[[linkText]] →"],
						),
					],
				),
			],
		),
	]),
	h.p(
		[h.Class("m-0 mb-2.5 mt-0.5 font-mono text-[11px] leading-[16px] text-maple-fg-muted")],
		["[[hint]]"],
	),
]

/** A ranked list under a section head: name, count, and a trailing figure. */
export const rankTable = (h: H): Html =>
	section(h, "px-6 pt-6", [
		"[[#head]]",
		panel(h, [
			h.table(
				[h.Class("w-full border-collapse")],
				[
					h.thead(
						[],
						[
							h.tr(
								[],
								[
									h.th(
										[
											h.Class("px-3 py-2"),
											h.Attribute("style", "border-bottom:1px solid #302b26"),
										],
										[],
									),
									headerCell(h, "right", "[[valueHeading]]"),
									headerCell(h, "right", "[[asideHeading]]", "w-[72px] "),
								],
							),
						],
					),
					h.tbody([], [rowsSlot(h, "rankRows")]),
				],
			),
		]),
	])

/** One ranked row: optional icon and the name over a share bar, the count, and a tinted figure. */
export const rankRow = (h: H): Html => {
	const cell = (extraClass: string, children: ReadonlyArray<Child>) =>
		h.td(
			[
				h.Class(`px-3 py-2 ${extraClass}align-middle`),
				h.Attribute("style", "border-bottom:[[rowBorder]]"),
			],
			children,
		)
	return h.tr(
		[],
		[
			cell("", [
				h.table(
					[],
					[
						h.tbody(
							[],
							[
								h.tr(
									[],
									[
										cellsSlot(h, "rowIcon"),
										h.td(
											[h.Class("align-middle")],
											[
												h.p(
													[
														h.Class(
															"m-0 font-mono text-[12px] leading-[20px] text-maple-fg",
														),
													],
													["[[label]]"],
												),
											],
										),
									],
								),
							],
						),
					],
				),
				h.div(
					[
						h.Attribute(
							"style",
							"margin-top:4px;height:3px;border-radius:2px;background-color:#302b26",
						),
					],
					[
						h.div(
							[
								h.Attribute(
									"style",
									"width:[[barWidth]]%;height:3px;border-radius:2px;background-color:#e8872a",
								),
							],
							[],
						),
					],
				),
			]),
			cell("text-right ", [
				h.p(
					[h.Class("m-0 font-mono text-[12px] font-semibold leading-[20px] text-maple-fg")],
					["[[value]]"],
				),
			]),
			cell("text-right ", [
				h.p(
					[
						h.Class("m-0 font-mono text-[11px] leading-[20px]"),
						h.Attribute("style", "color:[[asideColor]]"),
					],
					["[[aside]]"],
				),
			]),
		],
	)
}

/** A 16px leading icon cell for a list row (favicon, brand mark). */
export const rowIcon = (h: H): Html =>
	h.td([h.Class("w-[16px] pr-2 align-middle")], [iconImage(h, 16, ";border-radius:3px")])

/** A name and a count on one line, for the lists inside the AI columns. */
export const compactRow = (h: H): Html => {
	const cell = (className: string, children: ReadonlyArray<Child>) =>
		h.td([h.Class(className), h.Attribute("style", "border-top:1px solid #302b26")], children)
	return h.tr(
		[],
		[
			cell("w-[14px] py-1 pr-2 align-middle", [iconImage(h, 14)]),
			cell("py-1 align-middle", [
				h.p([h.Class("m-0 font-mono text-[11px] leading-[18px] text-maple-fg")], ["[[label]]"]),
			]),
			cell("py-1 text-right align-middle", [
				h.p(
					[h.Class("m-0 font-mono text-[11px] font-semibold leading-[18px] text-maple-fg")],
					["[[value]]"],
				),
			]),
		],
	)
}

/** A single muted line standing in for an empty block. */
export const quietLine = (h: H): Html =>
	section(h, "px-6 pt-3", [
		h.p([h.Class("m-0 font-mono text-[11px] leading-snug text-maple-fg-muted")], ["[[text]]"]),
	])

/** Label/value row in the alert detail table. */
export const detailRow = (h: H): Html =>
	h.tr(
		[],
		[
			h.td(
				[
					h.Class("w-[110px] px-3 py-2.5 align-top"),
					h.Attribute("style", "border-bottom:1px solid #302b26"),
				],
				[sectionLabel(h, ["[[label]]"])],
			),
			h.td(
				[h.Class("px-3 py-2.5 align-top"), h.Attribute("style", "border-bottom:1px solid #302b26")],
				[
					h.p(
						[
							h.Class("m-0 font-mono text-[13px] leading-snug"),
							h.Attribute("style", "color:[[valueColor]]"),
						],
						["[[value]]"],
					),
				],
			),
		],
	)
