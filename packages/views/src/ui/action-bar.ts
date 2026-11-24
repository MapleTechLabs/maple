import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { separator } from "./display"
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
	/** A full-width line above the row, such as a save failure. Card only. */
	notice?: ReadonlyArray<Html>
	/**
	 * `card` spans the column (step flows, editors with Back and a notice). `pill` is a compact,
	 * centred float for a short status and two buttons (the save bar).
	 */
	shape?: "card" | "pill"
	as?: "section" | "footer"
	/** Layout only: margins and the sticky offset when the scroll area pads its edge. */
	className?: string
	attributes?: ReadonlyArray<Attribute<M>>
}>

// The `after` strip covers the bar's offset and its shadow the scroll padding below, so rows
// scrolling past never show under the bar; a shadow adds no scroll height. A surface that is not
// `background` sets `--action-bar-backdrop`.
const BAR =
	"sticky bottom-4 z-10 mt-auto rounded-lg border bg-popover py-2 pr-2 pl-4 text-popover-foreground shadow-popup after:pointer-events-none after:absolute after:-inset-x-px after:top-full after:h-4 after:bg-(--action-bar-backdrop,var(--color-background)) after:shadow-backdrop-below"

// Narrow and centred, so it never lines up with the cards and reads as one more of them. It lifts
// a step in dark (the popover barely clears the page) and takes a deeper shade, so rows scrolling
// under it stay behind it without a backdrop strip. It rises in once; reduced motion just shows it.
const PILL =
	"sticky bottom-4 z-10 mt-auto mx-auto w-fit max-w-full self-center rounded-full border border-input bg-popover py-1 pr-1 pl-3.5 text-popover-foreground shadow-float before:pointer-events-none before:absolute before:inset-0 before:rounded-full before:shadow-control dark:bg-secondary animate-in fade-in-0 slide-in-from-bottom-3 zoom-in-97 duration-300 ease-out motion-reduce:animate-none sm:bottom-6"

const cardRow = <M>(h: HtmlBuilder<M>, options: ActionBarOptions<M>): Html =>
	hstack(h, { gap: "4", align: "center", justify: "between", wrap: true }, [
		hstack(h, { gap: "2", align: "center", shrink: true }, [...(options.leading ?? [])]),
		// The buttons wrap onto a second line on a narrow screen rather than run past the edge.
		hstack(
			h,
			{ gap: "1.5", align: "center", wrap: true, justify: "end", shrink: true, className: "ml-auto" },
			options.actions,
		),
	])

// One line that never wraps: the status gives way (it truncates) before the buttons do.
const pillRow = <M>(h: HtmlBuilder<M>, options: ActionBarOptions<M>): Html =>
	hstack(h, { gap: "2", align: "center" }, [
		hstack(h, { gap: "2", align: "center", shrink: true, className: "min-w-0" }, [
			...(options.leading ?? []),
		]),
		// The rule takes the pill's border tone (`border` vanishes on the lifted dark fill) and extra room on
		// its left, since the ghost button's padding already sits on its right.
		separator(h, "vertical", "ml-1 h-4 self-center bg-input"),
		hstack(h, { gap: "1", align: "center", className: "shrink-0" }, options.actions),
	])

export const actionBar = <M>(h: HtmlBuilder<M>, options: ActionBarOptions<M>): Html => {
	const isPill = options.shape === "pill"
	const attributes = [h.AriaLabel(options.label), ...(options.attributes ?? [])]
	const row = isPill ? pillRow(h, options) : cardRow(h, options)
	const children =
		isPill || options.notice === undefined || options.notice.length === 0
			? [row]
			: [vstack(h, { gap: "2", className: "pt-1" }, [...options.notice, row])]
	return vstack(
		h,
		{ as: options.as ?? "section", className: cn(isPill ? PILL : BAR, options.className), attributes },
		children,
	)
}
