import { place } from "@maple/web/ui/logs/chip-card"
import { Effect, Schema } from "effect"
import { LogsDefinition } from "./definition"
import { Message } from "./message"

/** Moves the card to `<body>` (Base UI's portal) and keeps it under its chip while anything scrolls. */
export const PlaceLocalChipCard = LogsDefinition.makeMount("PlaceLocalChipCard", {
	args: { anchorId: Schema.String },
	messages: [Message.PlacedChipCard],
	handler: function* () {
		return ({ element, anchorId }) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const positioner = element.firstElementChild
					const popup = positioner?.firstElementChild
					document.body.appendChild(element)
					const update = () => {
						const anchor = document.getElementById(anchorId)
						if (anchor !== null && positioner instanceof HTMLElement && popup instanceof HTMLElement)
							place(positioner, popup, anchor.getBoundingClientRect())
					}
					update()
					const listenerOptions = { capture: true, passive: true }
					window.addEventListener("scroll", update, listenerOptions)
					window.addEventListener("resize", update)
					return () => {
						window.removeEventListener("scroll", update, listenerOptions)
						window.removeEventListener("resize", update)
						element.remove()
					}
				}),
				(cleanup) => Effect.sync(cleanup),
			).pipe(Effect.as(Message.PlacedChipCard()))
	},
})
