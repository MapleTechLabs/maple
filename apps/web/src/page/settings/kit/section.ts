import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { heading } from "../../../ui/heading"
import { panel } from "../../../ui/panel"
import { sectionHeading } from "../../kit/section-heading"
import { emptyMessage } from "../../../ui/empty"

// `SettingsSection`, `SettingsSections`, `AdminOnlyNote`.

type Children = ReadonlyArray<Html | string>

export type SettingsSectionOptions = Readonly<{
	/** The heading id: stable per section so `aria-labelledby` resolves. */
	id: string
	title: string
	description?: Children
	actions?: Html
	/** A tag set right after the title (`Coming soon`), not pushed to the far edge like `actions`. */
	badge?: Html
	framed?: boolean
	padded?: boolean
	className?: string
	footer?: Html
	anchorId?: string
	/** The tab's opening section, titled and described by the page header: its heading is for screen readers only. */
	isLead?: boolean
}>

const descriptionOf = <M>(h: HtmlBuilder<M>, description: Children | undefined): ReadonlyArray<Html> =>
	description === undefined || description.length === 0
		? []
		: [h.p([h.Class("font-prose text-sm text-muted-foreground")], description)]

/** The lead section's heading: hidden, the page header already shows its title and description. */
const leadHeader = <M>(h: HtmlBuilder<M>, options: SettingsSectionOptions): Html =>
	heading(h, { level: 2, variant: "section", id: options.id, className: "sr-only" }, [options.title])

export const settingsSection = <M>(
	h: HtmlBuilder<M>,
	options: SettingsSectionOptions,
	children: Children,
): Html =>
	h.section(
		[
			...(options.anchorId === undefined ? [] : [h.Id(options.anchorId)]),
			h.AriaLabelledBy(options.id),
			h.Class(cn("flex w-full scroll-mt-6 flex-col gap-3", options.className)),
		],
		[
			options.isLead === true
				? leadHeader(h, options)
				: h.div(
						[h.Class("space-y-1")],
						[
							sectionHeading(h, {
								id: options.id,
								title: options.title,
								badge: options.badge,
								actions: options.actions,
							}),
							...descriptionOf(h, options.description),
						],
					),
			...((options.framed ?? true)
				? [panel(h, { padded: options.padded ?? true }, children)]
				: children),
			...(options.footer === undefined ? [] : [options.footer]),
		],
	)

export const settingsSections = <M>(h: HtmlBuilder<M>, children: Children): Html =>
	h.div([h.Class("flex w-full flex-col gap-10")], children)

export const adminOnlyNote = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.p([h.Class(cn("font-prose text-xs text-muted-foreground", className))], children)

/** The one inline link style across settings: primary text, underlined on hover. */
export const INLINE_LINK_CLASS = "text-primary underline-offset-4 hover:underline active:underline"

/** The centered one-line note a list section shows for empty or failed loads. */
export const sectionNote = <M>(h: HtmlBuilder<M>, text: string): Html => emptyMessage(h, {}, [text])
