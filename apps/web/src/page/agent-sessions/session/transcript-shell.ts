import { formatClockInTimezone } from "@maple/web-data/lib/timezone-format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon, type IconName } from "../../../ui/icon"
import type { Message } from "./message"

// The frame every transcript block shares: row, avatar and indent lanes.

type H = HtmlBuilder<Message>

export const AVATAR_SLOT = "flex w-6 shrink-0 justify-center"
export const BODY = "min-w-0 max-w-[900px] grow pl-3"
export const SPEAKER = "shrink-0 font-semibold text-ui text-foreground"
export const CLOCK = "shrink-0 font-mono text-2xs text-muted-foreground tabular-nums"
export const ON_HOVER =
	"opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100"
export const LABEL = "shrink-0 font-medium text-xs"
export const META = "min-w-0 truncate font-mono text-2xs text-muted-foreground"
const INDENT = "flex w-6 shrink-0 justify-center"
const MAX_INDENT_DEPTH = 6
export const COLUMN = "mx-auto w-full max-w-[1052px]"

/** `14:21:58` in the reader's timezone. */
export const clockOf = (epochMs: number, timeZone: string): string =>
	formatClockInTimezone(epochMs, { timeZone })

/** The nesting hairlines, one lane each. */
export const indentLanes = (h: H, depth: number): ReadonlyArray<Html> =>
	Array.from({ length: Math.min(Math.max(depth, 0), MAX_INDENT_DEPTH) }, (_, index) =>
		h.span(
			[h.Key(String(index)), h.AriaHidden(true), h.Class(cn(INDENT, "self-stretch"))],
			[h.span([h.Class("w-px bg-border")], [])],
		),
	)

export const avatar = (h: H, name: IconName, className: string): Html =>
	h.span(
		[h.AriaHidden(true), h.Class(cn("flex size-6 items-center justify-center rounded-full", className))],
		[icon(h, name, { size: 12 })],
	)

/** `Row`: indent lanes, the speaker slot (unless `flush`), and the body. */
export const row = (
	h: H,
	options: Readonly<{
		depth: number
		avatar?: Html
		isHang?: boolean
		isFlush?: boolean
		className?: string
	}>,
	children: ReadonlyArray<Html>,
): Html => {
	const isHang = options.isHang ?? false
	const isFlush = options.isFlush ?? false
	return h.div(
		[h.Class(cn("group/row flex px-2", options.className))],
		[
			...indentLanes(h, isHang ? options.depth - 1 : options.depth),
			...(isFlush
				? []
				: [
						h.span(
							[h.Class(cn(AVATAR_SLOT, isHang && "self-stretch"))],
							options.avatar === undefined ? [] : [options.avatar],
						),
					]),
			h.div([h.Class(isFlush ? "min-w-0 max-w-[924px] grow" : BODY)], children),
		],
	)
}

/** `InlineNote`: a dashed aside with a question mark. */
export const inlineNote = (h: H, children: ReadonlyArray<Html | string>, className?: string): Html =>
	h.div(
		[
			h.Class(
				cn(
					"flex items-start gap-2.5 rounded-md border border-input border-dashed bg-muted/20 px-3 py-2",
					className,
				),
			),
		],
		[
			icon(h, "CircleQuestionIcon", { size: 13, className: "mt-0.5 shrink-0 text-muted-foreground" }),
			h.p([h.Class("min-w-0 text-muted-foreground text-xs leading-relaxed")], children),
		],
	)
