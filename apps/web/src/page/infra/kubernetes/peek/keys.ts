import { Effect, Queue, Stream } from "effect"
import { Mount } from "foldkit"
import { peekStepFor } from "../../../kit/peek-keys"
import { Message } from "./message"

type PressedStepKey = ReturnType<typeof Message.PressedStepKey>

// `PodPeekSheet`'s key handling: ↓/J step forward, ↑/K back, wherever focus is (the popup's capture
// handler and the document hotkeys), except in a text field or with a modifier held.

/** Mounted with the sheet's content, so it listens only while a pod is peeked. */
export const MountPeekKeys = Mount.defineStream("MountPeekKeys", {
	messages: [Message.PressedStepKey],
	execute: () =>
		Stream.callback<PressedStepKey>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const onKeyDown = (event: Event) => {
						if (!(event instanceof KeyboardEvent)) return
						const step = peekStepFor(event)
						if (step === undefined) return
						event.preventDefault()
						event.stopPropagation()
						Queue.offerUnsafe(queue, Message.PressedStepKey({ step }))
					}
					document.addEventListener("keydown", onKeyDown, true)
					return onKeyDown
				}),
				(onKeyDown) => Effect.sync(() => document.removeEventListener("keydown", onKeyDown, true)),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})
