import type { Html, HtmlBuilder } from "foldkit/html"
import { titleId } from "../../ui/dialog"
import * as DialogView from "../../ui/dialog-view"
import * as SourcesFlow from "../sources/new/embed"
import { type ConnectDrawer, DRAWER_ID, DrawerMessage } from "./quick-start-drawer"

// The connect drawer: a right sheet with the flow's title and trail on top, its step below. The body
// is a `page` container, so the flow lays out as on `/sources/new` at this width (its rail stacks).

const header = <M>(h: HtmlBuilder<M>, drawer: ConnectDrawer, toParent: (message: DrawerMessage) => M): Html =>
	DialogView.dialogHeader(
		h,
		"sheet",
		[
			h.div(
				[h.Id(titleId(DRAWER_ID))],
				[
					h.submodel({
						slotId: `${DRAWER_ID}-header`,
						model: drawer.flow,
						view: SourcesFlow.headerEmbed,
						viewInputs: {},
						toParentMessage: (message) => toParent(DrawerMessage.GotFlowMessage({ message })),
					}),
				],
			),
		],
		"pr-14",
	)

const body = <M>(
	h: HtmlBuilder<M>,
	drawer: ConnectDrawer,
	timeZone: string,
	toParent: (message: DrawerMessage) => M,
): Html =>
	DialogView.dialogPanel(
		h,
		"sheet",
		DRAWER_ID,
		[
			h.div(
				[
					h.Class("@container/page flex min-h-full flex-col"),
					h.DataAttribute("connect-flow-scroll", ""),
				],
				[
					h.submodel({
						slotId: `${DRAWER_ID}-body`,
						model: drawer.flow,
						view: SourcesFlow.bodyEmbed,
						viewInputs: { timeZone },
						toParentMessage: (message) => toParent(DrawerMessage.GotFlowMessage({ message })),
					}),
				],
			),
		],
		// The flow's sticky footer pulls itself to the panel's bottom edge by this padding.
		"flex flex-col pt-1 pb-4",
	)

/** The drawer's portal while it is open or animating out; nothing once it is gone. */
export const drawerView = <M>(
	h: HtmlBuilder<M>,
	drawer: ConnectDrawer | null,
	timeZone: string,
	toParent: (message: DrawerMessage) => M,
): Html =>
	drawer === null
		? h.empty
		: h.submodel({
				slotId: `${DRAWER_ID}-sheet`,
				model: drawer.dialog,
				view: DialogView.view,
				viewInputs: {
					className: "w-full sm:max-w-3xl",
					side: "right",
					hasTrigger: false,
					hasDescription: false,
					toView: ({ portal }) => portal ?? h.empty,
					toContent: () => [header(h, drawer, toParent), body(h, drawer, timeZone, toParent)],
				},
				toParentMessage: (message) => toParent(DrawerMessage.GotDialogMessage({ message })),
			})
