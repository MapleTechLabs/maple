import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { hstack, vstack } from "./stack"

// `ActionBar`: the one sticky bar a form, editor or step flow pins to the bottom of its scroll area:
// a floating card, so it reads the same in a page, a capped settings column and a sheet.

export type ActionBarOptions<M> = Readonly<{
	/** The landmark's name ("Unsaved changes", "Rule actions"). */
	label: string
	/** Status or context on the left (a dirty dot, a hint, Back). */
	leading?: ReadonlyArray<Html>
	/** Buttons on the right, primary last. */
	actions: ReadonlyArray<Html>
	/** A full-width line above the row, such as a save failure. */
	notice?: ReadonlyArray<Html>
	as?: "section" | "footer"
	/** Layout only: margins and the sticky offset when the scroll area pads its edge. */
	className?: string
	attributes?: ReadonlyArray<Attribute<M>>
}>

const BAR =
	"sticky bottom-4 z-10 mt-auto rounded-lg border bg-popover py-2 pr-2 pl-4 text-popover-foreground shadow-popup"

export const actionBar = <M>(h: HtmlBuilder<M>, options: ActionBarOptions<M>): Html => {
	const attributes = [h.AriaLabel(options.label), ...(options.attributes ?? [])]
	const row = hstack(h, { gap: "4", align: "center", justify: "between", wrap: true }, [
		hstack(h, { gap: "2", align: "center", shrink: true }, [...(options.leading ?? [])]),
		hstack(h, { gap: "1.5", align: "center", className: "ml-auto shrink-0" }, options.actions),
	])
	const children =
		options.notice === undefined || options.notice.length === 0
			? [row]
			: [vstack(h, { gap: "2", className: "pt-1" }, [...options.notice, row])]
	return vstack(h, { as: options.as ?? "section", className: cn(BAR, options.className), attributes }, children)
}
