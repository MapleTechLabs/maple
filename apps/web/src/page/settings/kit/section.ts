import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { panel } from "../../../ui/panel"
import { sectionHeading } from "../../kit/section-heading"

// `SettingsSection`, `SettingsSections`, `AdminOnlyNote`.

export type SettingsWidth = "standard" | "wide"

const widthClass = (width: SettingsWidth) => (width === "wide" ? "w-full" : "w-full max-w-3xl")

type Children = ReadonlyArray<Html | string>

export type SettingsSectionOptions = Readonly<{
	/** The heading id: stable per section so `aria-labelledby` resolves. */
	id: string
	title: string
	description?: Children
	actions?: Html
	framed?: boolean
	padded?: boolean
	className?: string
	footer?: Html
	width?: SettingsWidth
	anchorId?: string
}>

export const settingsSection = <M>(h: HtmlBuilder<M>, options: SettingsSectionOptions, children: Children): Html =>
	h.section(
		[
			...(options.anchorId === undefined ? [] : [h.Id(options.anchorId)]),
			h.AriaLabelledBy(options.id),
			h.Class(cn("flex scroll-mt-6 flex-col gap-3", widthClass(options.width ?? "standard"), options.className)),
		],
		[
			h.div(
				[h.Class("space-y-1")],
				[
					sectionHeading(h, { id: options.id, title: options.title, actions: options.actions }),
					...(options.description === undefined || options.description.length === 0
						? []
						: [h.p([h.Class("font-prose text-sm text-muted-foreground")], options.description)]),
				],
			),
			...((options.framed ?? true) ? [panel(h, { padded: options.padded ?? true }, children)] : children),
			...(options.footer === undefined ? [] : [options.footer]),
		],
	)

export const settingsSections = <M>(h: HtmlBuilder<M>, width: SettingsWidth, children: Children): Html =>
	h.div([h.Class(cn("flex flex-col gap-10", widthClass(width)))], children)

export const adminOnlyNote = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.p([h.Class(cn("text-xs text-muted-foreground", className))], children)

/** The centered one-line note a list section shows for empty or failed loads. */
export const sectionNote = <M>(h: HtmlBuilder<M>, text: string): Html =>
	h.p([h.Class("px-4 py-6 text-center text-sm text-muted-foreground")], [text])
