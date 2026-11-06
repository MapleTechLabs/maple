// Classes the onboarding steps share: the scrolling column and its pinned footer.

/** A step's column: side padding on everything but its footer, which pads itself. */
export const STEP_BODY_CLASS =
	"flex flex-1 flex-col gap-7 pt-4 [&>:not(:last-child)]:px-6 sm:[&>:not(:last-child)]:px-12 lg:[&>:not(:last-child)]:px-16"

/** The step's actions, pinned to the bottom of the scrolling column so Continue never scrolls away. */
export const STEP_FOOTER_CLASS =
	"sticky bottom-0 z-10 mt-auto flex items-center justify-end gap-4 border-t border-border bg-background px-6 py-4 sm:px-12 lg:px-16"
