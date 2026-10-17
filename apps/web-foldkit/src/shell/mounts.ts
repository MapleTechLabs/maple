import { Schema, Stream } from "effect"
import { Dom, Mount } from "foldkit"
import { Align, measurePosition, Side } from "../ui/anchor"
import { Menu, Message } from "./message"

/**
 * Positions an open menu's positioner against its trigger (Base UI's anchor positioning), on
 * insert and on every viewport resize, and moves focus into the popup like Base UI on open.
 */
export const PositionMenu = Mount.defineStream("PositionMenu", {
	args: {
		menu: Menu,
		triggerId: Schema.String,
		popupId: Schema.String,
		side: Side,
		align: Align,
		sideOffset: Schema.Number,
	},
	messages: [Message.MeasuredMenuPopup],
	execute: ({ element, menu, triggerId, popupId, side, align, sideOffset }) => {
		const measure = () => {
			const position = measurePosition(element, triggerId, { side, align, sideOffset, alignOffset: 0 })
			return position === undefined
				? Stream.empty
				: Stream.succeed(Message.MeasuredMenuPopup({ menu, position }))
		}
		const initial = Stream.suspend(() => {
			const popup = element.ownerDocument.getElementById(popupId)
			if (popup instanceof HTMLElement) popup.focus({ preventScroll: true })
			return measure()
		})
		const resized = Dom.streamFromEvent({
			target: window,
			type: "resize",
			mapEvent: () => undefined,
		}).pipe(Stream.flatMap(measure))
		return Stream.concat(initial, resized)
	},
})
