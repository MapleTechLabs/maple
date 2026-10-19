import { Effect } from "effect"
import { Mount } from "foldkit"
import { defineMessageUnion } from "foldkit/message"

// DOM glue the chat sidebar needs that Foldkit's event attributes do not express.

export const MountMessage = defineMessageUnion({ CompletedMountStopClick: {}, CompletedMountRenameInput: {} })

/** The row's actions trigger: `onClick={(e) => e.stopPropagation()}`, so it never selects the row. */
export const MountStopClickPropagation = Mount.define("MountChatStopClickPropagation", {
	messages: [MountMessage.CompletedMountStopClick],
	execute: ({ element }) =>
		Effect.as(
			Effect.acquireRelease(
				Effect.sync(() => {
					const stop = (event: Event) => event.stopPropagation()
					element.addEventListener("click", stop)
					return stop
				}),
				(stop) => Effect.sync(() => element.removeEventListener("click", stop)),
			),
			MountMessage.CompletedMountStopClick(),
		),
})

/** The rename input focuses with its text selected, a frame after it appears. */
export const MountRenameInput = Mount.define("MountChatRenameInput", {
	messages: [MountMessage.CompletedMountRenameInput],
	execute: ({ element }) =>
		Effect.callback<ReturnType<typeof MountMessage.CompletedMountRenameInput>>((resume) => {
			const handle = requestAnimationFrame(() => {
				if (element instanceof HTMLInputElement) {
					element.focus()
					element.select()
				}
				resume(Effect.succeed(MountMessage.CompletedMountRenameInput()))
			})
			return Effect.sync(() => cancelAnimationFrame(handle))
		}),
})
