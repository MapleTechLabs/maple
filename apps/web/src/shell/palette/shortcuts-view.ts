import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { dialogDescription, dialogHeader, dialogPanel, dialogTitle } from "../../ui/dialog-view"
import { kbd, kbdGroup } from "../../ui/display"
import { eyebrow } from "../../ui/eyebrow"
import { displayAlternates, type Platform, SHORTCUT_GROUPS, SHORTCUTS, type ShortcutDef } from "./shortcuts"

// The keyboard shortcuts dialog.

export const SHORTCUTS_DIALOG_ID = "keyboard-shortcuts"

const row = <M>(h: HtmlBuilder<M>, def: ShortcutDef, platform: Platform): Html =>
	h.div(
		[h.Class("flex items-center justify-between gap-4 py-1.5")],
		[
			h.span([h.Class("text-sm")], [def.label]),
			h.span(
				[h.Class("flex shrink-0 items-center gap-1.5")],
				displayAlternates(def, platform).flatMap((tokens, index) => [
					...(index > 0 ? [h.span([h.Class("text-muted-foreground text-xs")], ["or"])] : []),
					kbdGroup(
						h,
						undefined,
						tokens.map((token) => kbd(h, undefined, [token])),
					),
				]),
			),
		],
	)

const groups = <M>(h: HtmlBuilder<M>, platform: Platform): ReadonlyArray<Html> =>
	SHORTCUT_GROUPS.flatMap((group) => {
		const defs = SHORTCUTS.filter((def) => def.group === group)
		return defs.length === 0
			? []
			: [
					h.div(
						[],
						[
							eyebrow(h, { variant: "label", className: "mb-1", as: "h3" }, [group]),
							h.div(
								[h.Class("divide-y divide-border/50")],
								defs.map((def) => row(h, def, platform)),
							),
						],
					),
				]
	})

/** The dialog's content; `measure` is the panel viewport's overflow Mount, owned by the dialog's parent. */
export const shortcutsDialogContent = <M, R = never>(
	h: HtmlBuilder<M, R>,
	dialogId: string,
	platform: Platform,
	measure: Attribute<M, R>,
): ReadonlyArray<Html> => [
	dialogHeader(h, "dialog", [
		dialogTitle(h, "dialog", dialogId, "Keyboard shortcuts"),
		dialogDescription(
			h,
			"dialog",
			dialogId,
			"Available across Maple. Press ? anywhere to open this list.",
		),
	]),
	dialogPanel(h, "dialog", dialogId, [h.div([h.Class("space-y-4")], groups(h, platform))], undefined, {
		viewportAttributes: [measure],
	}),
]
