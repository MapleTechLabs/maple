import * as Animation from "@foldkit/ui/animation"
import { Effect, Option, Schema, Stream } from "effect"
import { Command, Dom, Mount, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { outsidePresses, strayEscapes } from "./overlay/anchored"
import { lockBodyScroll, manageFocus, markOutside, portalToBody, trapFocus } from "./overlay/portal"

/**
 * Base UI `Dialog` / `AlertDialog` as one Submodel: open state, the enter/exit transition, and a
 * Mount that portals the popup to `<body>`, marks the page outside it, locks scroll and traps
 * focus. `dialog-view.ts` renders Dialog, AlertDialog, Sheet and the command palette's dialog.
 */

// MODEL

export const Kind = Schema.Literals(["dialog", "alert-dialog", "sheet", "command-dialog"])
export type Kind = typeof Kind.Type

export const Model = Schema.Struct({
	id: Schema.String,
	kind: Kind,
	isOpen: Schema.Boolean,
	animation: Animation.Model,
})
export type Model = typeof Model.Type

export const popupId = (id: string): string => `${id}-popup`
export const triggerId = (id: string): string => `${id}-trigger`
export const titleId = (id: string): string => `${id}-title`
export const descriptionId = (id: string): string => `${id}-description`

/** `<Dialog defaultOpen>` is `init(id, kind, { isOpen: true })`: open with no enter transition. */
export const init = (id: string, kind: Kind, options: Readonly<{ isOpen?: boolean }> = {}): Model => ({
	id,
	kind,
	isOpen: options.isOpen ?? false,
	animation: Animation.init({ id: popupId(id), isShowing: options.isOpen ?? false }),
})

// MESSAGE

export const Message = defineMessageUnion({
	ClickedTrigger: {},
	ClickedClose: {},
	PressedEscape: {},
	PressedOutside: {},
	CompletedMountDialog: {},
	GotAnimationMessage: { message: Animation.Message },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ Opened: {}, Closed: {} })
export type OutMessage = typeof OutMessage.Type

// UPDATE

/** The exit transition ends when the popup's CSS transitions settle (`useOpenChangeComplete`). */
export const WaitForDialogTransition = Command.define("WaitForDialogTransition", {
	args: { id: Schema.String, generation: Schema.Number },
	messages: [Message.GotAnimationMessage],
	execute: ({ id, generation }) =>
		Dom.waitForAnimationSettled(`#${CSS.escape(popupId(id))}`).pipe(
			Effect.as(
				Message.GotAnimationMessage({ message: Animation.Message.EndedAnimation({ generation }) }),
			),
		),
})

const animationFold = {
	read: (model: Model) => Option.some(model.animation),
	write: (model: Model, animation: Animation.Model) => modifyFields(model, { animation: () => animation }),
	toParentMessage: (message: Animation.Message) => Message.GotAnimationMessage({ message }),
}

const foldAnimation = Update.foldChild({
	...animationFold,
	update: Animation.update,
	foldOutMessage: Animation.OutMessage.match<Update.Step<Model, Message>>({
		StartedLeaveAnimating:
			({ generation }) =>
			(model) => ({ model, commands: [WaitForDialogTransition({ id: model.id, generation })] }),
		TransitionedOut: () => (model) => ({ model }),
	}),
})
const showAnimation = Update.foldChildStep({ ...animationFold, update: Animation.show })
const hideAnimation = Update.foldChildStep({ ...animationFold, update: Animation.hide })

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

export const open = (model: Model): UpdateReturn =>
	model.isOpen
		? { model }
		: Update.withOutMessage(OutMessage.Opened())(
				showAnimation(modifyFields(model, { isOpen: () => true })),
			)

export const close = (model: Model): UpdateReturn =>
	model.isOpen
		? Update.withOutMessage(OutMessage.Closed())(
				hideAnimation(modifyFields(model, { isOpen: () => false })),
			)
		: { model }

/** An alert dialog ignores presses outside it; Escape and its buttons still close it. */
export const isDismissedByOutsidePress = (kind: Kind): boolean => kind !== "alert-dialog"

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		ClickedTrigger: () => (model.isOpen ? close(model) : open(model)),
		ClickedClose: () => close(model),
		PressedEscape: () => close(model),
		PressedOutside: () => (isDismissedByOutsidePress(model.kind) ? close(model) : { model }),
		CompletedMountDialog: () => ({ model }),
		GotAnimationMessage: ({ message: animationMessage }) => foldAnimation(model, animationMessage),
	})

// MOUNT

/** A popup opened from inside the dialog (a select, a menu): its portal is outside the popup but
 * pressing in it is not a press outside the dialog (Base UI's floating tree). */
const nestedPopups = (portal: Element) =>
	`[data-base-ui-portal]:not([data-slot^="toast"])${portal.id === "" ? "" : `:not(#${CSS.escape(portal.id)})`}`

/**
 * On the portal root: moves it to `<body>`, hides the rest of the page from assistive tech,
 * locks scroll, traps focus and moves it in; releasing (unmount) undoes each and returns focus.
 */
export const MountDialog = Mount.defineStream("MountDialog", {
	args: {
		id: Schema.String,
		hasTrigger: Schema.Boolean,
		isPopupFocused: Schema.Boolean,
		isReturningFocus: Schema.Boolean,
	},
	messages: [Message.CompletedMountDialog, Message.PressedOutside, Message.PressedEscape],
	execute: ({ element, id, hasTrigger, isPopupFocused, isReturningFocus }) =>
		Stream.unwrap(
			Effect.gen(function* () {
				yield* portalToBody(element)
				yield* markOutside(element, { mark: true, ariaHidden: true })
				yield* lockBodyScroll
				const mounted = Stream.make(Message.CompletedMountDialog())
				const popup = element.querySelector(`#${CSS.escape(popupId(id))}`)
				if (!(element instanceof HTMLElement) || !(popup instanceof HTMLElement)) return mounted
				yield* trapFocus(element, popup)
				yield* manageFocus(popup, {
					returnFocusId: hasTrigger ? Option.some(triggerId(id)) : Option.none(),
					initialFocus: isPopupFocused ? "popup" : "first-tabbable",
					isReturningFocus,
				})
				return Stream.concat(
					mounted,
					Stream.merge(
						outsidePresses(popup, [nestedPopups(element)]).pipe(
							Stream.map(() => Message.PressedOutside()),
						),
						strayEscapes(element).pipe(Stream.map(() => Message.PressedEscape())),
					),
				)
			}),
		),
})
