import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Dialog from "../../ui/dialog"
import {
	dialogDescription,
	dialogHeader,
	dialogPanel,
	dialogTitle,
	view as dialogView,
} from "../../ui/dialog-view"
import { kbd, kbdGroup } from "../../ui/display"
import { eyebrow } from "../../ui/eyebrow"
import { MeasurePaletteList } from "./command"
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

/** The dialog's portal; `onMeasured` reports the panel's overflow Mount. */
export const shortcutsDialogView = <M>(
	h: HtmlBuilder<M>,
	dialog: Dialog.Model,
	platform: Platform,
	toMessage: (message: Dialog.Message) => M,
	onMeasured: M,
): Html =>
	h.submodel({
		slotId: "keyboard-shortcuts",
		model: dialog,
		view: dialogView,
		viewInputs: {
			hasTrigger: false,
			toView: ({ portal }) => portal,
			toContent: () => [
				dialogHeader(h, "dialog", [
					dialogTitle(h, "dialog", dialog.id, "Keyboard shortcuts"),
					dialogDescription(
						h,
						"dialog",
						dialog.id,
						"Available across Maple. Press ? anywhere to open this list.",
					),
				]),
				dialogPanel(
					h,
					"dialog",
					dialog.id,
					[h.div([h.Class("space-y-4")], groups(h, platform))],
					undefined,
					{
						viewportAttributes: [
							h.OnMount(Mount.mapMessage(MeasurePaletteList(), () => onMeasured)),
						],
					},
				),
			],
		},
		toParentMessage: toMessage,
	})
