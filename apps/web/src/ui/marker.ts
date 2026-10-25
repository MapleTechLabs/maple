import { cn } from "@maple/ui/lib/utils"
import { markerContentStyles, markerIconStyles, markerVariants } from "@maple/ui/styles/ui/marker"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/marker.tsx: an inline event marker in a timeline or thread.

export type MarkerVariant = "default" | "separator" | "border"
type Children = ReadonlyArray<Html | string>

export const marker = <M>(
	h: HtmlBuilder<M>,
	options: { readonly variant?: MarkerVariant; readonly className?: string },
	children: Children,
): Html => {
	const variant = options.variant ?? "default"
	return h.div(
		[
			h.Class(cn(markerVariants({ variant, className: options.className }))),
			h.DataAttribute("slot", "marker"),
			h.DataAttribute("variant", variant),
		],
		children,
	)
}

export const markerIcon = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.span(
		[
			h.DataAttribute("slot", "marker-icon"),
			h.AriaHidden(true),
			h.Class(cn(markerIconStyles, className)),
		],
		children,
	)

export const markerContent = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.span([h.DataAttribute("slot", "marker-content"), h.Class(cn(markerContentStyles, className))], children)
