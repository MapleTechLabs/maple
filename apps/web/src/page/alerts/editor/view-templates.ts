import { cn } from "@maple/ui/lib/utils"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button } from "../../../ui/button"
import * as DialogView from "../../../ui/dialog-view"
import { icon, type IconName } from "../../../ui/icon"
import { inlineCode } from "../../../ui/inline-code"
import { ALERT_TEMPLATES } from "../shared/templates"
import { Message } from "./message"
import type { Model } from "./model"

// `RuleTemplatesOverlay`: the first-touch picker.

type H = HtmlBuilder<Message>

const TILE_CLASS = cn(
	"group flex h-full flex-col gap-3 rounded-md border bg-card p-4 text-left transition-colors",
	"hover:border-primary/40 hover:bg-primary/[0.03] focus-visible:outline-none",
	"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
)

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
					h.span([h.Class("font-medium text-sm")], [title]),
				],
			),
			h.p([h.Class("text-muted-foreground text-xs leading-snug")], [subtitle]),
		],
	)

const tiles = (h: H): ReadonlyArray<Html> => [
	...ALERT_TEMPLATES.map((template) =>
		h.button(
			[h.Type("button"), h.Class(TILE_CLASS), h.OnClick(Message.ClickedTemplate({ id: template.id }))],
			[
				tileHead(h, template.icon, template.title, template.description),
				h.div(
					[h.Class("mt-auto flex items-center justify-between")],
					[
						inlineCode(h, { className: "text-2xs text-muted-foreground" }, [template.summary]),
						icon(h, "ChevronRightIcon", {
							size: 14,
							className:
								"text-muted-foreground transition-transform group-hover:translate-x-0.5",
						}),
					],
				),
			],
		),
	),
	h.button(
		[h.Type("button"), h.Class(TILE_CLASS), h.OnClick(Message.ClickedStartBlank())],
		[
			tileHead(h, "AlertWarningIcon", "Start blank", "Build a rule from scratch."),
			h.p(
				[h.Class("text-muted-foreground text-xs")],
				["Begin with the defaults and pick a signal yourself."],
			),
		],
	),
	h.a(
		[h.Href(hrefOf(AppRoute.Dashboards({ search: {} }))), h.Class(TILE_CLASS)],
		[
			tileHead(h, "ChartLineIcon", "From a dashboard chart", "Convert an existing visualization."),
			h.p(
				[h.Class("text-muted-foreground text-xs")],
				["Open a dashboard, then choose “Create alert” from a chart's menu."],
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
			toContent: () => [
				DialogView.dialogHeader(h, "dialog", [
					DialogView.dialogTitle(h, "dialog", templates.id, "Start with a template"),
					DialogView.dialogDescription(
						h,
						"dialog",
						templates.id,
						"These cover the most common alerts. Pick one — every field stays editable after.",
					),
				]),
				h.div([h.Class("grid gap-3 px-6 pb-2 md:grid-cols-3")], tiles(h)),
				h.div(
					[h.Class("flex items-center justify-end px-6 py-4")],
					[
						button(
							h,
							{
								variant: "ghost",
								size: "sm",
								attributes: [h.OnClick(Message.ClickedSkipTemplates())],
							},
							["Skip — use defaults"],
						),
					],
				),
			],
		},
		toParentMessage: (message) => Message.GotTemplatesMessage({ message }),
	})

const slot = createLazy()

/** The picker, rebuilt only when its dialog changes. */
export const templatesOverlay = (h: H, model: Model): Html => slot(overlay, [h, model.templates])
