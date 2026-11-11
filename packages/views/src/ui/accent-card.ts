import { cn } from "@maple/ui/lib/utils"
import type { Tone } from "@maple/ui/lib/tone"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

// A card-filled box with a 2px leading rule in a tone: a quoted message, or a post as it will read.

const RULE = {
	crit: "border-l-severity-error",
	warn: "border-l-severity-warn",
	ok: "border-l-severity-info",
	info: "border-l-severity-info",
	done: "border-l-severity-debug",
	live: "border-l-primary",
	neutral: "border-l-border",
} as const satisfies Record<Tone, string>

const PADDING = { default: "p-4", sm: "px-3 py-2.5" } as const

/** `AccentCard`: a card-filled box led by a 2px rule in a tone, for a quoted or previewed message. */
export const accentCard = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		tone: Tone
		size?: keyof typeof PADDING
		className?: string
		attributes?: ReadonlyArray<Attribute<M>>
	}>,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.div(
		[
			...(options.attributes ?? []),
			h.Class(
				cn(
					"flex min-w-0 flex-col gap-2 rounded-md border border-l-2 bg-card",
					RULE[options.tone],
					PADDING[options.size ?? "default"],
					options.className,
				),
			),
			h.DataAttribute("slot", "accent-card"),
		],
		children,
	)
