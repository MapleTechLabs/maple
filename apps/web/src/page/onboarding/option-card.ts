import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { PIXEL_GLYPHS } from "../../ui/icons.generated"

// `OptionCard` (row layout), `DrawnCheck` and the onboarding `PixelGlyph`. Each animation is drawn at
// its end state.

export type PixelGlyphName = keyof typeof PIXEL_GLYPHS

/** `rasterOrder`: segments top row first, left to right, so the reveal scans. */
const rasterOrder = (segments: ReadonlyArray<string>): ReadonlyArray<string> => {
	const origin = (d: string) => {
		const [x = 0, y = 0] = d
			.slice(1)
			.trim()
			.split(/[\s,]+/)
			.map(Number)
		return { x, y }
	}
	return [...segments].sort((a, b) => {
		const p = origin(a)
		const q = origin(b)
		return p.y - q.y || p.x - q.x
	})
}

const segmentPath = <M>(h: HtmlBuilder<M>, d: string, extra: ReadonlyArray<Attribute<M>>): Html =>
	h.path([
		h.Attribute("d", d),
		h.Attribute("stroke", "currentColor"),
		h.Attribute("stroke-width", "2"),
		h.Attribute("stroke-linecap", "square"),
		...extra,
	])

/** `DrawnCheck`: the tick at its drawn (`pathLength` 1) or undrawn end state. */
const drawnCheck = <M>(h: HtmlBuilder<M>, isChecked: boolean, className: string | false | undefined): Html =>
	h.span(
		[
			h.AriaHidden(true),
			h.Class(
				cn(
					"flex size-4 shrink-0 items-center justify-center rounded-sm border transition-[color,background-color,border-color,opacity] duration-150 motion-reduce:transition-none",
					isChecked
						? "border-primary bg-primary text-primary-foreground"
						: "border-input bg-background group-hover:border-foreground/40",
					className,
				),
			),
		],
		[
			h.svg(
				[h.Attribute("viewBox", "0 0 24 24"), h.Class("size-3"), h.Attribute("fill", "none")],
				[
					h.path([
						h.Attribute("d", "M5.252 12.7 10.2 18.63 18.748 5.37"),
						h.Attribute("stroke", "currentColor"),
						h.Attribute("stroke-width", "3"),
						h.Attribute("stroke-linecap", "round"),
						h.Attribute("stroke-linejoin", "round"),
						h.Attribute("pathLength", "1"),
						h.Attribute("stroke-dashoffset", "0"),
						h.Attribute("stroke-dasharray", isChecked ? "1 1" : "0 1"),
						h.Style({ opacity: isChecked ? "1" : "0" }),
					]),
				],
			),
		],
	)

export type OptionCardOptions<M> = Readonly<{
	type: "radio" | "checkbox"
	name?: string
	isChecked: boolean
	onChange: M
	isDisabled?: boolean
	label: string
	title: string
	description: string
	media: Html
	/** `row`: media, text, check side by side. `stacked`: media and check above the text. */
	layout?: "row" | "stacked"
	/** Content pinned to the bottom of a `stacked` card. */
	footer?: Html
	/** Hex colour that replaces primary for the selected border and tint. */
	accent?: string
	/** Classes for the selected check, paired with `accent`. */
	checkClassName?: string
}>

/** `OptionCard`: a hidden native input behind a bordered card. */
export const optionCard = <M>(h: HtmlBuilder<M>, options: OptionCardOptions<M>): Html => {
	const layout = options.layout ?? "row"
	const check = drawnCheck(
		h,
		options.isChecked,
		cn(
			layout === "row" && "mt-0.5",
			options.isChecked ? options.checkClassName : options.type === "radio" && "opacity-0",
		),
	)
	const body: ReadonlyArray<Html> =
		layout === "row"
			? [
					options.media,
					h.div(
						[h.Class("min-w-0 flex-1 pt-px")],
						[
							h.span([h.Class("block text-sm font-semibold")], [options.title]),
							h.span(
								[h.Class("mt-1 block text-xs leading-relaxed text-muted-foreground")],
								[options.description],
							),
						],
					),
					check,
				]
			: [
					h.div([h.Class("flex items-start justify-between")], [options.media, check]),
					h.div(
						[h.Class("space-y-1")],
						[
							h.span(
								[h.Class("block text-base font-semibold tracking-tight")],
								[options.title],
							),
							h.span([h.Class("block text-sm text-muted-foreground")], [options.description]),
						],
					),
					...(options.footer === undefined
						? []
						: [h.div([h.Class("mt-auto flex")], [options.footer])]),
				]
	const isAccented = options.isChecked && options.accent !== undefined
	return h.label(
		[h.Class("group relative cursor-pointer")],
		[
			h.input([
				h.Type(options.type),
				...(options.name === undefined ? [] : [h.Name(options.name)]),
				h.Class("peer sr-only"),
				h.Checked(options.isChecked),
				...(options.isDisabled === true ? [h.Disabled(true)] : []),
				h.AriaLabel(options.label),
				h.OnChange(() => options.onChange),
			]),
			h.div(
				[
					...(isAccented
						? [
								h.Style({
									"border-color": options.accent ?? "",
									"background-color": `${options.accent ?? ""}0F`,
								}),
							]
						: []),
					h.Class(
						cn(
							"flex h-full rounded-md border transition-colors duration-150 motion-reduce:transition-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
							layout === "row" ? "items-start gap-3 p-4" : "flex-col gap-5 p-5",
							!options.isChecked
								? "border-border group-hover:border-foreground/30 group-hover:bg-foreground/[0.02]"
								: options.accent === undefined && "border-primary bg-primary/5",
						),
					),
				],
				body,
			),
		],
	)
}

export const pixelGlyph = <M>(h: HtmlBuilder<M>, name: PixelGlyphName, isSelected: boolean): Html => {
	const segments = rasterOrder(PIXEL_GLYPHS[name])
	return h.span(
		[
			h.Class(
				cn(
					"flex size-10 shrink-0 items-center justify-center rounded-lg transition-colors duration-200 motion-reduce:transition-none",
					isSelected ? "bg-primary/10" : "bg-muted/60 group-hover:bg-muted",
				),
			),
		],
		[
			h.svg(
				[
					h.AriaHidden(true),
					h.Attribute("focusable", "false"),
					h.Attribute("viewBox", "0 0 24 24"),
					h.Attribute("width", "24"),
					h.Attribute("height", "24"),
					h.Attribute("fill", "none"),
				],
				[
					h.g(
						[
							h.Class(
								cn(
									"transition-colors duration-200 motion-reduce:transition-none",
									isSelected
										? "text-primary/40"
										: "text-muted-foreground group-hover:text-foreground",
								),
							),
						],
						segments.map((d) => segmentPath(h, d, [])),
					),
					h.g(
						[h.Class("text-primary")],
						segments.map((d) =>
							segmentPath(h, d, [h.Style({ opacity: isSelected ? "1" : "0" })]),
						),
					),
				],
			),
		],
	)
}
