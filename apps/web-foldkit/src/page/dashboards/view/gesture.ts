import type { PageContext, PageReturn } from "../../contract"
import type { Message } from "./message"
import type { Model } from "./model"

// `useGridInteraction` (dashboard-builder/canvas/use-grid-interaction.ts): pointer drag and resize
// over the canvas, one commit on release.

type GestureMessage = Extract<
	Message,
	{ readonly _tag: "PressedGrip" | "PressedResizeHandle" | "MovedPointer" | "ReleasedPointer" }
>

/** TODO(grid-drag): drag, resize and keyboard rearranging are not ported; presses are ignored. */
export const gestureStep = (
	model: Model,
	_context: PageContext,
	_message: GestureMessage,
): PageReturn<Model, Message> => ({ model })
