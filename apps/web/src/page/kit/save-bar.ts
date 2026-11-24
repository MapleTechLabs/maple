import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { actionBar } from "@maple/views/ui/action-bar"

// Floats while a settings tab has unsaved edits; Mod+S presses its Save (the shell's `globalShortcuts`).
// TODO(settings): confirm before navigating away (and the browser's beforeunload prompt) needs a
// root-level navigation blocker.

/** Marks the button Mod+S presses: the one save bar on the page. */
export const SAVE_SHORTCUT_ATTRIBUTE = "shortcut-save"

export type SaveBarOptions<M> = Readonly<{
	isDirty: boolean
	isPending?: boolean
	/** How many edits are unsaved, when the page counts them ("2 unsaved changes"). */
	changeCount?: number
	context?: string
	onDiscard: M
	onSave: M
	saveLabel?: string
	isSaveDisabled?: boolean
	className?: string
}>

// The pill's buttons take its corners, so the hover fill follows the curve.
const PILL_BUTTON = "rounded-full before:rounded-full"

const statusOf = (count: number | undefined): string =>
	count === undefined ? "Unsaved changes" : `${count} unsaved ${count === 1 ? "change" : "changes"}`

export const saveBar = <M>(h: HtmlBuilder<M>, options: SaveBarOptions<M>): ReadonlyArray<Html> => {
	const isPending = options.isPending ?? false
	if (!options.isDirty && !isPending) return []
	return [
		actionBar(h, {
			label: "Unsaved changes",
			shape: "pill",
			className: cn("mt-6", options.className),
			leading: [
				statusDot(h, { tone: isPending ? "neutral" : "live" }),
				typography(h, { size: "sm", tone: "foreground", className: "shrink-0 whitespace-nowrap" }, [
					isPending ? "Saving changes" : statusOf(options.changeCount),
				]),
				// The context is a hint; a phone keeps the status and both buttons on one line instead.
				...(options.context === undefined || options.context.length === 0
					? []
					: [
							typography(
								h,
								{
									size: "sm",
									tone: "muted",
									truncate: true,
									className: "max-w-64 max-sm:hidden",
								},
								[options.context],
							),
						]),
			],
			actions: [
				button(
					h,
					{
						variant: "ghost",
						size: "sm",
						className: PILL_BUTTON,
						isDisabled: isPending,
						attributes: [h.OnClick(options.onDiscard)],
					},
					["Discard"],
				),
				button(
					h,
					{
						size: "sm",
						className: PILL_BUTTON,
						isLoading: isPending,
						isDisabled: options.isSaveDisabled ?? false,
						attributes: [
							h.OnClick(options.onSave),
							h.DataAttribute(SAVE_SHORTCUT_ATTRIBUTE, ""),
							h.Attribute("aria-keyshortcuts", "Meta+S Control+S"),
						],
					},
					[options.saveLabel ?? "Save"],
				),
			],
		}),
	]
}
