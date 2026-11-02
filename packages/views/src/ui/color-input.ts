import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/** `ColorInput`: a native colour picker drawn as a small bordered swatch, reporting the picked hex colour. */
export type ColorInputOptions<M> = Readonly<{
	/** A `#rrggbb` value; the native picker accepts nothing else. */
	value: string
	/** Accessible name ("Threshold color"). */
	label: string
	onInput: (color: string) => M
	className?: string
	attributes?: ReadonlyArray<Attribute<M>>
}>

const BASE = "h-8 w-8 shrink-0 cursor-pointer rounded-sm border bg-transparent p-0.5"

export const colorInput = <M>(h: HtmlBuilder<M>, options: ColorInputOptions<M>): Html =>
	h.input([
		h.Type("color"),
		h.Value(options.value),
		h.OnInput(options.onInput),
		h.Class(cn(BASE, options.className)),
		h.AriaLabel(options.label),
		h.DataAttribute("slot", "color-input"),
		...(options.attributes ?? []),
	])
