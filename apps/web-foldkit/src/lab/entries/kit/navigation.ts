import { Option, Schema } from "effect"
import { Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as NavigationMenu from "../../../ui/navigation-menu"
import * as Resizable from "../../../ui/resizable"
import * as Tooltip from "../../../ui/tooltip"
import { defineLab } from "../../define"
import { kitPage, kitSection } from "../../kit/kit-layout"
import { sidebarFrame } from "../../kit/navigation-sidebar"

// `/lab/kit/navigation`: navigation menu, an
// expanded and a collapsed sidebar, and nested resizable panel groups.

// MODEL

const Model = Schema.Struct({
	navigationMenu: NavigationMenu.Model,
	railTooltip: Tooltip.Model,
	outerPanels: Resizable.Model,
	innerPanels: Resizable.Model,
})
type Model = typeof Model.Type

const init = (): Update.Return<Model, Message> => ({
	model: {
		navigationMenu: NavigationMenu.init("kit-navigation-menu", { value: "product" }),
		railTooltip: Tooltip.init("kit-rail-tooltip", { side: "right", align: "center" }),
		outerPanels: Resizable.init("kit-resizable-outer", "horizontal", [40, 60]),
		innerPanels: Resizable.init("kit-resizable-inner", "vertical", [50, 50]),
	},
})

// MESSAGE

const Message = defineMessageUnion({
	GotNavigationMenuMessage: { message: NavigationMenu.Message },
	GotRailTooltipMessage: { message: Tooltip.Message },
	GotOuterPanelsMessage: { message: Resizable.Message },
	GotInnerPanelsMessage: { message: Resizable.Message },
})
type Message = typeof Message.Type

// UPDATE

const fold = <Field extends keyof Model, ChildMessage>(
	field: Field,
	update: (model: Model[Field], message: ChildMessage) => Update.Return<Model[Field], ChildMessage>,
	toParentMessage: (message: ChildMessage) => Message,
) =>
	Update.foldChild({
		update,
		read: (model: Model) => Option.some(model[field]),
		write: (model: Model, next: Model[Field]): Model => ({ ...model, [field]: next }),
		toParentMessage,
	})

const foldNavigationMenu = fold("navigationMenu", NavigationMenu.update, (message) =>
	Message.GotNavigationMenuMessage({ message }),
)
const foldRailTooltip = fold("railTooltip", Tooltip.update, (message) =>
	Message.GotRailTooltipMessage({ message }),
)
const foldOuterPanels = fold("outerPanels", Resizable.update, (message) =>
	Message.GotOuterPanelsMessage({ message }),
)
const foldInnerPanels = fold("innerPanels", Resizable.update, (message) =>
	Message.GotInnerPanelsMessage({ message }),
)

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		GotNavigationMenuMessage: ({ message: child }) => foldNavigationMenu(model, child),
		GotRailTooltipMessage: ({ message: child }) => foldRailTooltip(model, child),
		GotOuterPanelsMessage: ({ message: child }) => foldOuterPanels(model, child),
		GotInnerPanelsMessage: ({ message: child }) => foldInnerPanels(model, child),
	})

// VIEW

type H = HtmlBuilder<Message>

const PRODUCT = ["Traces", "Logs", "Metrics", "Session replay"]

const navigationMenuItems = (h: H): ReadonlyArray<NavigationMenu.NavigationMenuItem> => [
	{
		_tag: "Trigger",
		value: "product",
		label: "Product",
		content: [
			h.ul(
				[h.Class("grid w-96 grid-cols-2 gap-1 p-2")],
				PRODUCT.map((title) =>
					h.li(
						[],
						[
							NavigationMenu.navigationMenuLink(
								h,
								`#${title.toLowerCase().replace(" ", "-")}`,
								[title],
							),
						],
					),
				),
			),
		],
	},
	{
		_tag: "Trigger",
		value: "docs",
		label: "Docs",
		content: [h.div([h.Class("w-64 p-3 text-sm")], ["Guides and API reference."])],
	},
	{ _tag: "Link", label: "Pricing", href: "#pricing" },
]

const railTriggerId = (title: string): string => `kit-rail-${title.toLowerCase()}`
const RAIL_TITLES = ["Traces", "Logs", "Metrics", "Hosts", "Alerts"]

const sidebars = (h: H, model: Model): Html =>
	h.div(
		[h.Class("flex gap-6")],
		[
			sidebarFrame(h, {
				name: "Expanded sidebar",
				state: "expanded",
				tooltipTrigger: () => [],
				tooltipPortal: null,
			}),
			// `hidden={state !== "collapsed"}`: only the collapsed rail shows its tooltips.
			h.submodel({
				slotId: "rail-tooltip",
				model: model.railTooltip,
				view: Tooltip.view,
				viewInputs: {
					toView: ({ trigger, portal }) =>
						sidebarFrame(h, {
							name: "Collapsed sidebar",
							state: "collapsed",
							tooltipTrigger: (title) => trigger(railTriggerId(title)),
							tooltipPortal: portal,
						}),
					triggerIds: RAIL_TITLES.map(railTriggerId),
					toContent: (triggerId) =>
						RAIL_TITLES.filter((title) => railTriggerId(title) === triggerId),
				},
				toParentMessage: (message) => Message.GotRailTooltipMessage({ message }),
			}),
		],
	)

const panelText = (h: H, text: string): ReadonlyArray<Html> => [h.div([h.Class("p-3 text-sm")], [text])]

const resizable = (h: H, model: Model): Html =>
	h.div(
		[h.Class("h-40 overflow-hidden rounded-md border")],
		[
			h.submodel({
				slotId: "resizable-outer",
				model: model.outerPanels,
				view: Resizable.view,
				viewInputs: {
					withHandle: [true],
					toPanels: () => [
						panelText(h, "Waterfall"),
						[
							h.submodel({
								slotId: "resizable-inner",
								model: model.innerPanels,
								view: Resizable.view,
								viewInputs: {
									withHandle: [false],
									toPanels: () => [panelText(h, "Span details"), panelText(h, "Events")],
								},
								toParentMessage: (message) => Message.GotInnerPanelsMessage({ message }),
							}),
						],
					],
				},
				toParentMessage: (message) => Message.GotOuterPanelsMessage({ message }),
			}),
		],
	)

const view = (model: Model, h: H): Html =>
	h.div(
		[h.Id("app")],
		[
			kitPage(
				h,
				{
					title: "Kit: navigation",
					description: "Sidebar, navigation menu and resizable panels from @maple/ui.",
				},
				[
					kitSection(h, "Navigation menu", [
						h.div(
							[h.Class("min-h-40")],
							[
								h.submodel({
									slotId: "navigation-menu",
									model: model.navigationMenu,
									view: NavigationMenu.view,
									viewInputs: { items: navigationMenuItems(h) },
									toParentMessage: (message) =>
										Message.GotNavigationMenuMessage({ message }),
								}),
							],
						),
					]),
					kitSection(h, "Sidebar (expanded and collapsed)", [sidebars(h, model)]),
					kitSection(h, "Resizable", [resizable(h, model)]),
				],
			),
		],
	)

/** `/lab/kit/navigation`: the Product menu open on mount (`defaultValue`). */
export const lab = defineLab("Kit: navigation", { Model, init, update, view, devTools: { Message } })
