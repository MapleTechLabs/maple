import { type LiftedRail, splitPageRails } from "@maple/web/shell/page-rails"
import * as Dialog from "@maple/web/ui/dialog"
import * as DialogView from "@maple/web/ui/dialog-view"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "../message"
import type { Model } from "../model"

// The page shell's drawer: `SheetPopup side="left"`
// around a copy of the page's own rail, which stays (hidden below `md`) in the page body.

type VNode = NonNullable<Html>

/** A fresh copy of a built subtree (no `elm`), so the same nodes can patch a second place. */
const cloneNode = (node: VNode): VNode => ({
	...node,
	elm: undefined,
	data: node.data === undefined ? undefined : { ...node.data },
	children: node.children?.map((child) => (typeof child === "string" ? child : cloneNode(child))),
})

/** Legacy renders the sidebar twice while the drawer is open: hidden inline, and in the drawer. */
export const filterRailOf = (model: Model, page: Html): Option.Option<LiftedRail> =>
	model.filterDrawer.isOpen
		? Option.map(splitPageRails(page).maybeFilters, (rail) => ({
				...rail,
				children: rail.children.map((child) => (child === null ? child : cloneNode(child))),
			}))
		: Option.none()

/** `{drawerOpen ? <div className="h-full min-h-0">{sidebar}</div> : null}` after the sr-only title. */
export const filterDrawer = (
	h: HtmlBuilder<Message>,
	model: Model,
	maybeRail: Option.Option<LiftedRail>,
): Html =>
	h.submodel({
		slotId: `${model.filterDrawer.id}-dialog`,
		model: model.filterDrawer,
		view: DialogView.view,
		viewInputs: {
			className: "py-3",
			side: "left",
			hasDescription: false,
			toView: ({ portal }) => portal,
			toContent: () => [
				DialogView.dialogTitle(h, "sheet", model.filterDrawer.id, "Filters", "sr-only"),
				...Option.toArray(
					Option.map(maybeRail, (rail) => h.div([h.Class("h-full min-h-0")], rail.children)),
				),
			],
		},
		toParentMessage: (message: Dialog.Message) => Message.GotFilterDrawerMessage({ message }),
	})
