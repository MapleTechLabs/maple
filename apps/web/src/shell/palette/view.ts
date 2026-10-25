import { cn } from "@maple/ui/lib/utils"
import * as A from "@maple/ui/styles/ui/autocomplete"
import * as CommandStyles from "@maple/ui/styles/ui/command"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Combobox from "../../ui/combobox"
import {
	type CommandGroup,
	commandFooter,
	commandHiddenInput,
	commandInput,
	commandList,
} from "../../ui/command"
import type * as Dialog from "../../ui/dialog"
import { view as dialogView } from "../../ui/dialog-view"
import { kbd } from "../../ui/display"
import { icon } from "../../ui/icon"
import { manifestGlyph } from "../../ui/manifest-glyph"
import { serviceDot } from "../../ui/values"
import { type Glyph, groupEntries, type PaletteEntry } from "./entries"
import { MeasurePaletteList } from "./command"
import { Message, type Model } from "./model"
import { type Context, shownEntries } from "./update"

// `CommandPalette`'s popup: the input, the grouped entries (or "No results"), the footer hints.

export type ViewInputs = Readonly<{ context: Context; visibleFlagged: ReadonlyArray<string> }>

const GLYPH_CLASS = "shrink-0 text-muted-foreground"

const glyph = <M>(h: HtmlBuilder<M>, value: Glyph): Html => {
	switch (value._tag) {
		case "Icon":
			return icon(h, value.name, { size: 16, className: GLYPH_CLASS })
		case "Manifest":
			return manifestGlyph(h, value.icon, 16, { className: GLYPH_CLASS, monochrome: true })
		case "Service":
			return serviceDot(h, { serviceName: value.serviceName })
	}
}

const groupsOf = <M>(h: HtmlBuilder<M>, entries: ReadonlyArray<PaletteEntry>): ReadonlyArray<CommandGroup> =>
	groupEntries(entries).map((section) => ({
		label: section.group,
		items: section.entries.map((entry) => ({
			title: entry.title,
			value: entry.id,
			leading: glyph(h, entry.glyph),
			shortcut: entry.shortcut,
			href: entry.target._tag === "Href" ? entry.target.href : undefined,
		})),
	}))

const hint = <M>(h: HtmlBuilder<M>, key: string, text: string): Html =>
	h.span([h.Class("flex items-center gap-1.5")], [kbd(h, undefined, [key]), text])

/** `CommandEmpty`: `No results for “{query}”.`, the query its own text run. */
const empty = <M>(h: HtmlBuilder<M>, query: string): Html =>
	h.div(
		[
			h.AriaAtomic(true),
			h.AriaLive("polite"),
			h.Class(cn(A.autocompleteEmptyStyles, CommandStyles.commandEmptyStyles)),
			h.DataAttribute("slot", "command-empty"),
			h.Role("status"),
		],
		["No results for “", query, "”."],
	)

const PLACEHOLDER = "Search pages, dashboards, actions…"

/** The palette's dialog portal, placed by the shell's overlay layer. */
export const paletteView = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	inputs: ViewInputs,
	toMessage: (message: Message) => M,
): Html => {
	const toList = (message: Combobox.Message) =>
		toMessage(
			message._tag === "PressedInputKey" && message.key === "Enter"
				? Message.PressedEnter({ visibleFlagged: inputs.visibleFlagged })
				: Message.GotListMessage({ message }),
		)
	const shown = shownEntries(model, inputs.context, inputs.visibleFlagged)
	const groups = groupsOf(h, shown.entries)
	return h.submodel({
		slotId: "command-palette",
		model: model.dialog,
		view: dialogView,
		viewInputs: {
			hasTrigger: false,
			toView: ({ portal }) => portal,
			toContent: () => [
				commandInput(
					h,
					model.list,
					{ placeholder: PLACEHOLDER, groups, hasDismissButton: true, isUnfiltered: true },
					toList,
				),
				commandList(h, model.list, groups, toList, {
					isUnfiltered: true,
					itemClassName: "flex items-center gap-2",
					onClickItem: (id) => toMessage(Message.ClickedEntry({ id })),
					empty: shown.isSearch ? empty(h, model.list.inputValue) : undefined,
					viewportAttributes: [h.OnMount(Mount.mapMessage(MeasurePaletteList(), toMessage))],
					hasMeasuredScrollbar: true,
				}),
				commandFooter(h, [hint(h, "↵", " to open"), hint(h, "Esc", " to close")]),
				commandHiddenInput(h, model.list),
			],
		},
		toParentMessage: (message: Dialog.Message) => toMessage(Message.GotDialogMessage({ message })),
	})
}
