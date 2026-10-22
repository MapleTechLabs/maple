import { Effect, Queue, Schema, Stream } from "effect"
import { Mount } from "foldkit"
import { defineMessageUnion } from "foldkit/message"

// `PodTable`'s `onPeek`: a plain click on a row peeks instead of following its link; a modified or
// middle click still navigates. Foldkit links route through a document listener that skips a
// prevented click, so the table's own listener prevents it and reports the row (`podKey`).

export const PeekRowMessage = defineMessageUnion({
	ClickedPeekRow: { key: Schema.String },
})
export type PeekRowMessage = typeof PeekRowMessage.Type

export const MountPodPeek = Mount.defineStream("MountPodPeek", {
	messages: [PeekRowMessage.ClickedPeekRow],
	execute: ({ element }) =>
		Stream.callback<PeekRowMessage>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const onClick = (event: Event) => {
						if (!(event instanceof MouseEvent)) return
						const isPlain =
							event.button === 0 &&
							!event.metaKey &&
							!event.ctrlKey &&
							!event.shiftKey &&
							!event.altKey
						const row =
							event.target instanceof Element ? event.target.closest("a[data-peek-key]") : null
						const key = row?.getAttribute("data-peek-key")
						if (!isPlain || key === null || key === undefined) return
						event.preventDefault()
						Queue.offerUnsafe(queue, PeekRowMessage.ClickedPeekRow({ key }))
					}
					element.addEventListener("click", onClick)
					return onClick
				}),
				(onClick) => Effect.sync(() => element.removeEventListener("click", onClick)),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})
