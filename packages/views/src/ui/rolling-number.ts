import { cn } from "@maple/ui/lib/utils"
import { Array as Arr } from "effect"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

export type RollingNumberOptions<Message> = Readonly<{
	/** The formatted value ("1.2K", "185ms", "$12.50"); its digits roll, the rest is set as text. */
	text: string
	className?: string
	attributes?: ReadonlyArray<Attribute<Message>>
}>

/** One digit cell and each row of its strip: a touch taller than the glyph so nothing clips. */
const CELL = "1.15em"
const DIGITS = Arr.range(0, 9)

/**
 * A digit as a 0-9 strip in a one-row window, moved to its value. Keyed from the right, so "44" to
 * "18" rolls both digits in place and "92ms" to "185ms" keeps the unit still.
 */
const digitCell = <Message>(h: HtmlBuilder<Message>, digit: number, key: string): Html =>
	h.span(
		[
			h.Key(key),
			h.AriaHidden(true),
			h.Class("relative inline-block overflow-hidden select-none"),
			h.Style({ height: CELL }),
		],
		[
			h.span(
				[
					h.Class(
						"flex flex-col transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
					),
					h.Style({ transform: `translateY(-${digit * 1.15}em)` }),
				],
				Arr.map(DIGITS, (value) =>
					h.span(
						[h.Class("block text-center"), h.Style({ height: CELL, lineHeight: CELL })],
						[String(value)],
					),
				),
			),
		],
	)

/** `RollingNumber`: a formatted number whose digits roll to their new value when it changes. */
export const rollingNumber = <Message>(
	h: HtmlBuilder<Message>,
	options: RollingNumberOptions<Message>,
): Html => {
	const chars = Arr.fromIterable(options.text)
	return h.span(
		[
			h.Class(cn("inline-flex items-start tabular-nums", options.className)),
			...(options.attributes ?? []),
		],
		[
			h.span([h.Key("label"), h.Class("sr-only")], [options.text]),
			...Arr.map(chars, (char, index) => {
				const fromRight = chars.length - index
				const digit = Number.parseInt(char, 10)
				return Number.isNaN(digit)
					? h.span(
							[
								h.Key(`c${fromRight}${char}`),
								h.AriaHidden(true),
								h.Class("whitespace-pre select-none"),
								h.Style({ height: CELL, lineHeight: CELL }),
							],
							[char],
						)
					: digitCell(h, digit, `d${fromRight}`)
			}),
		],
	)
}
