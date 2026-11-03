import { Effect, Queue, Stream } from "effect"
import { Mount } from "foldkit"
import { peekStepFor } from "../../../kit/peek-keys"
import { Message } from "./message"

type PressedStepKey = ReturnType<typeof Message.PressedStepKey>

/** Mounted with the drawer's content, so it listens only while an endpoint is peeked. */
export const MountEndpointPeekKeys = Mount.defineStream("MountEndpointPeekKeys", {
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
