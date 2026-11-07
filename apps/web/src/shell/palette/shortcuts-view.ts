import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Dialog from "@maple/views/ui/dialog"
import {
	dialogDescription,
	dialogHeader,
	dialogPanel,
	dialogTitle,
	view as dialogView,
} from "@maple/views/ui/dialog-view"
import { kbd, kbdGroup } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { MeasureCommandList } from "@maple/views/ui/command"
import { displayAlternates, type Platform, SHORTCUT_GROUPS, SHORTCUTS, type ShortcutDef } from "./shortcuts"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// The keyboard shortcuts dialog.

export const SHORTCUTS_DIALOG_ID = "keyboard-shortcuts"

const row = <M>(h: HtmlBuilder<M>, def: ShortcutDef, platform: Platform): Html =>
	hstack(h, { gap: "4", align: "center", justify: "between", className: "py-1.5" }, [
		typography(h, { size: "sm" }, [def.label]),
		hstack(
			h,
			{ gap: "1.5", as: "span", className: "shrink-0" },
			Arr.flatMap(displayAlternates(def, platform), (tokens, index) => [
				...(index > 0 ? [typography(h, { size: "xs", tone: "muted" }, ["or"])] : []),
				kbdGroup(
					h,
					undefined,
					Arr.map(tokens, (token) => kbd(h, undefined, [token])),
				),
			]),
		),
	])

const groups = <M>(h: HtmlBuilder<M>, platform: Platform): ReadonlyArray<Html> =>
	Arr.flatMap(SHORTCUT_GROUPS, (group) => {
		const defs = Arr.filter(SHORTCUTS, (def) => def.group === group)
		return defs.length === 0
			? []
			: [
					h.div(
						[],
						[
							eyebrow(h, { variant: "label", className: "mb-1", as: "h3" }, [group]),
							h.div(
								[h.Class("divide-y divide-border-subtle")],
								Arr.map(defs, (def) => row(h, def, platform)),
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
							h.OnMount(Mount.mapMessage(MeasureCommandList(), () => onMeasured)),
						],
					},
				),
			],
		},
		toParentMessage: toMessage,
	})
