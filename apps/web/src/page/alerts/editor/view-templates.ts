import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button } from "../../../ui/button"
import { cardButton } from "../../../ui/card-button"
import * as DialogView from "../../../ui/dialog-view"
import { icon, type IconName } from "../../../ui/icon"
import { inlineCode } from "../../../ui/inline-code"
import { ALERT_TEMPLATES } from "../shared/templates"
import { Message } from "./message"
import type { Model } from "./model"

// `RuleTemplatesOverlay`: the first-touch picker.

type H = HtmlBuilder<Message>

const TILE_LAYOUT = "flex h-full flex-col gap-3 p-4"

const tileHead = (h: H, iconName: IconName, title: string, subtitle: string): Html =>
	h.div(
		[h.Class("space-y-1")],
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					h.span(
						[
							h.Class(
								"flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary",
							),
						],
						[icon(h, iconName, { size: 18 })],
					),
					h.span([h.Class("font-prose font-medium text-sm")], [title]),
				],
			),
			h.p([h.Class("font-prose text-muted-foreground text-xs leading-snug")], [subtitle]),
		],
	)

const chevron = (h: H): Html =>
	icon(h, "ChevronRightIcon", {
		size: 14,
		className: "shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5",
	})

const tiles = (h: H): ReadonlyArray<Html> => [
	...ALERT_TEMPLATES.map((template) =>
		cardButton(h, { onClick: Message.ClickedTemplate({ id: template.id }), className: TILE_LAYOUT }, [
			tileHead(h, template.icon, template.title, template.description),
			h.div(
				[h.Class("mt-auto flex min-w-0 items-center justify-between gap-2")],
				[
					inlineCode(
						h,
						{
							className: "min-w-0 truncate whitespace-nowrap text-2xs text-muted-foreground",
						},
						[template.summary],
					),
					chevron(h),
				],
			),
		]),
	),
	cardButton(h, { onClick: Message.ClickedStartBlank(), className: TILE_LAYOUT }, [
		tileHead(h, "SquarePlusIcon", "Start blank", "Build a rule from scratch."),
		h.div(
			[h.Class("mt-auto flex min-w-0 items-center justify-between gap-2")],
			[
				// One line, so the chevron sits on the same row as the siblings' chips.
				h.p(
					[h.Class("min-w-0 truncate font-prose text-muted-foreground text-xs")],
					["Choose a signal"],
				),
				chevron(h),
			],
		),
	]),
	// Instructions, not a choice: a note under the tiles rather than another card.
	h.p(
		[h.Class("mt-1 flex items-center gap-2 font-prose text-muted-foreground text-xs md:col-span-3")],
		[
			icon(h, "ChartBarIcon", { size: 14, className: "shrink-0" }),
			h.span(
				[],
				[
					"To alert on a dashboard chart, open it in ",
					h.a(
						[
							h.Href(hrefOf(AppRoute.Dashboards({ search: {} }))),
							h.Class("text-foreground underline underline-offset-2"),
						],
						["Dashboards"],
					),
					" and choose “Create alert” from the chart's menu.",
				],
			),
		],
	),
]

const overlay = (h: H, templates: Model["templates"]): Html =>
	h.submodel({
		slotId: "alert-rule-templates",
		model: templates,
		view: DialogView.view,
		viewInputs: {
			hasTrigger: false,
			hasDescription: true,
			className: "w-[860px] max-w-[92vw]",
			toView: ({ portal }) => portal,
			toContent: (close) => [
				DialogView.dialogHeader(h, "dialog", [
					DialogView.dialogTitle(h, "dialog", templates.id, "Start with a template"),
					DialogView.dialogDescription(
						h,
						"dialog",
						templates.id,
						"These cover the most common alerts. Every field stays editable after you pick one.",
					),
				]),
				h.div([h.Class("grid gap-3 px-6 pb-6 md:grid-cols-3")], tiles(h)),
				DialogView.dialogFooter(h, "dialog", [
					button(h, { variant: "outline", attributes: [...close] }, ["Cancel"]),
				]),
			],
		},
		toParentMessage: (message) => Message.GotTemplatesMessage({ message }),
	})

const slot = createLazy()

/** The picker, rebuilt only when its dialog changes. */
export const templatesOverlay = (h: H, model: Model): Html => slot(overlay, [h, model.templates])
