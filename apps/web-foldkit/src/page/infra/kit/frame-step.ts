import { Command } from "foldkit"
import type { PageReturn } from "../../contract"
import * as Frame from "./frame"

// A page's `GotFrameMessage` handler: runs the frame's update, then lets the page act on a resolved
// window (request its data) or a new time search (navigate), keeping the frame's own Commands.

export type FrameHost = Readonly<{ frame: Frame.Model }>

export const liftFrame = <Model extends FrameHost, Message>(
	model: Model,
	message: Frame.Message,
	scope: Frame.Scope,
	wrap: (message: Frame.Message) => Message,
	handlers: Readonly<{
		onResolved: (model: Model, mode: Frame.RequestMode) => PageReturn<Model, Message>
		onTimeSearch: (model: Model, search: Frame.Scope["search"]) => PageReturn<Model, Message>
	}>,
): PageReturn<Model, Message> => {
	const next = Frame.update(model.frame, message, scope)
	const lifted: Model = { ...model, frame: next.model }
	const commands = Command.mapMessages(next.commands ?? [], wrap)
	const out = next.outMessage
	if (out === undefined) return { model: lifted, commands }
	const followed =
		out._tag === "ResolvedWindow"
			? handlers.onResolved(lifted, out.mode)
			: handlers.onTimeSearch(lifted, out.search)
	return { ...followed, commands: [...commands, ...(followed.commands ?? [])] }
}

/** The page's entry resolve, lifted. */
export const resolveFrame = <Message>(
	frame: Frame.Model,
	scope: Frame.Scope,
	wrap: (message: Frame.Message) => Message,
	mode?: Frame.RequestMode,
) => Command.mapMessage(Frame.resolve(frame, scope, mode), wrap)
