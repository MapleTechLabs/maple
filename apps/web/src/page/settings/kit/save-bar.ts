import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import type { SettingsWidth } from "./section"

// `SettingsSaveBar`: pinned while a tab has unsaved edits. TODO(settings): its `UnsavedChangesGuard`
// (confirm before navigating away, and the browser's beforeunload prompt) needs a root-level navigation
// blocker; not implemented.

export type SaveBarOptions<M> = Readonly<{
	isDirty: boolean
	isPending?: boolean
	context?: string
	onDiscard: M
	onSave: M
	saveLabel?: string
	isSaveDisabled?: boolean
	width?: SettingsWidth
	className?: string
}>

export const saveBar = <M>(h: HtmlBuilder<M>, options: SaveBarOptions<M>): ReadonlyArray<Html> => {
	const isPending = options.isPending ?? false
	if (!options.isDirty && !isPending) return []
	return [
		h.section(
			[
				h.AriaLabel("Unsaved changes"),
				h.Class(
					cn(
						"sticky bottom-4 z-10 mt-6 flex w-full items-center justify-between gap-4 rounded-lg border bg-popover py-2 pr-2 pl-4 shadow-lg",
						(options.width ?? "standard") === "standard" && "max-w-3xl",
						options.className,
					),
				),
			],
			[
				h.div(
					[h.Class("flex min-w-0 items-center gap-2 text-sm")],
					[
						h.span(
							[h.AriaHidden(true), h.Class("size-1.5 shrink-0 rounded-full bg-primary")],
							[],
						),
						h.span([h.Class("shrink-0 text-foreground")], ["Unsaved changes"]),
						...(options.context === undefined
							? []
							: [h.span([h.Class("truncate text-muted-foreground")], [options.context])]),
					],
				),
				h.div(
					[h.Class("flex shrink-0 items-center gap-1.5")],
					[
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
				),
			],
		),
	]
}
