import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { actionBar } from "@maple/views/ui/action-bar"

// Pinned while a settings tab has unsaved edits. TODO(settings): confirm before navigating away
// (and the browser's beforeunload prompt) needs a root-level navigation blocker.

export type SaveBarOptions<M> = Readonly<{
	isDirty: boolean
	isPending?: boolean
	context?: string
	onDiscard: M
	onSave: M
	saveLabel?: string
	isSaveDisabled?: boolean
	className?: string
}>

export const saveBar = <M>(h: HtmlBuilder<M>, options: SaveBarOptions<M>): ReadonlyArray<Html> => {
	const isPending = options.isPending ?? false
	if (!options.isDirty && !isPending) return []
	return [
		actionBar(h, {
			label: "Unsaved changes",
			className: cn("mt-6", options.className),
			leading: [
				statusDot(h, { tone: "live" }),
				typography(h, { size: "sm", tone: "foreground", className: "shrink-0" }, ["Unsaved changes"]),
				...(options.context === undefined
					? []
					: [typography(h, { size: "sm", tone: "muted", truncate: true }, [options.context])]),
			],
			actions: [
				button(
					h,
					{
						variant: "ghost",
						size: "sm",
						isDisabled: isPending,
						attributes: [h.OnClick(options.onDiscard)],
					},
					["Discard"],
				),
				button(
					h,
					{
						size: "sm",
						isLoading: isPending,
						isDisabled: options.isSaveDisabled ?? false,
						attributes: [h.OnClick(options.onSave)],
					},
					[options.saveLabel ?? "Save"],
				),
			],
		}),
	]
}
