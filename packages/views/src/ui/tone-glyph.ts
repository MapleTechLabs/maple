import { TONE_SOFT, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon, type IconName } from "./icon"

export type ToneGlyphOptions = Readonly<{
	iconName: IconName
	tone: Tone
	/** `sm` is a 20px tile for dense rows, `default` 24px. */
	size?: "sm" | "default"
	className?: string
}>

const SIZE = {
	sm: { box: "size-5", glyph: 12 },
	default: { box: "size-6", glyph: 14 },
} as const

/** A glyph on a small tile tinted in one tone, naming a row's kind at a glance (a timeline's sessions, events, errors). */
export const toneGlyph = <M>(h: HtmlBuilder<M>, options: ToneGlyphOptions): Html => {
	const size = SIZE[options.size ?? "default"]
	return h.span(
		[
			h.AriaHidden(true),
			h.Class(
				cn(
					"inline-flex shrink-0 items-center justify-center rounded-md",
					size.box,
					TONE_SOFT[options.tone],
					options.className,
				),
			),
		],
		[icon(h, options.iconName, { size: size.glyph })],
	)
}
