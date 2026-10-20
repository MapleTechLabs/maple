import * as Animation from "@foldkit/ui/animation"
import { Effect, Option, Schema } from "effect"
import { Command, Dom, Update } from "foldkit"
import { Align, Side } from "./position"

/**
 * Open state shared by every anchored popup's Model: open flag, Base UI transition status and
 * the side and alignment the positioner rendered on (after any flip).
 */
export const PopupState = Schema.Struct({
	id: Schema.String,
	isOpen: Schema.Boolean,
	animation: Animation.Model,
	side: Side,
	align: Align,
})
export type PopupState = typeof PopupState.Type

export const popupId = (id: string): string => `${id}-popup`
export const triggerId = (id: string): string => `${id}-trigger`
export const portalId = (id: string): string => `${id}-portal`

export const initPopup = (
	id: string,
	options: Readonly<{ isOpen?: boolean; side: Side; align: Align }>,
): PopupState => ({
	id,
	isOpen: options.isOpen ?? false,
	animation: Animation.init({ id: popupId(id), isShowing: options.isOpen ?? false }),
	side: options.side,
	align: options.align,
})

/**
 * Lifts the Animation transition into a component whose Model embeds `PopupState` fields and
 * whose Message has `GotAnimationMessage`: show/hide on open/close, wait for the exit transition.
 */
export const makeTransition = <Model extends PopupState, Message>(
	toParentMessage: (message: Animation.Message) => Message,
	commandName: string,
) => {
	const WaitForExit = Command.define(commandName, {
		args: { id: Schema.String, generation: Schema.Number },
		messages: [Animation.Message.EndedAnimation],
		execute: ({ id, generation }) =>
			Dom.waitForAnimationSettled(`#${CSS.escape(popupId(id))}`).pipe(
				Effect.as(Animation.Message.EndedAnimation({ generation })),
			),
	})
	const fold = {
		read: (model: Model) => Option.some(model.animation),
		write: (model: Model, animation: Animation.Model): Model => ({ ...model, animation }),
		toParentMessage,
	}
	const foldAnimation = Update.foldChild({
		...fold,
		update: Animation.update,
		foldOutMessage: Animation.OutMessage.match<Update.Step<Model, Message>>({
			StartedLeaveAnimating:
				({ generation }) =>
				(model) => ({
					model,
					commands: [
						Command.mapMessage(WaitForExit({ id: model.id, generation }), toParentMessage),
					],
				}),
			TransitionedOut: () => (model) => ({ model }),
		}),
	})
	const show = Update.foldChildStep({ ...fold, update: Animation.show })
	const hide = Update.foldChildStep({ ...fold, update: Animation.hide })
	return {
		WaitForExit,
		foldAnimation,
		open: (model: Model): Update.Return<Model, Message> =>
			model.isOpen ? { model } : show({ ...model, isOpen: true }),
		close: (model: Model): Update.Return<Model, Message> =>
			model.isOpen ? hide({ ...model, isOpen: false }) : { model },
	}
}
