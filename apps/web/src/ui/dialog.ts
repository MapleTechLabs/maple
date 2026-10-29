import { Effect, Option, pipe, Schema, Stream } from "effect"
import { Block, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { outsidePresses, strayEscapes } from "./overlay/anchored"
import { PopupTransitionBlock } from "./overlay/popup-transition"
import { lockBodyScroll, manageFocus, markOutside, portalToBody, trapFocus } from "./overlay/portal"

/**
 * Base UI `Dialog` / `AlertDialog` as one Block: open state, the enter/exit transition, and a
 * Mount that portals the popup to `<body>`, marks the page outside it, locks scroll and traps
 * focus. `dialog-view.ts` renders Dialog, AlertDialog, Sheet and the command palette's dialog
 * and completes `DialogBlock`.
 */

// MODEL

export const Kind = Schema.Literals(["dialog", "alert-dialog", "sheet", "command-dialog"])
export type Kind = typeof Kind.Type

export const Model = Schema.Struct({
	id: Schema.String,
	kind: Kind,
	isOpen: Schema.Boolean,
	animation: PopupTransitionBlock.Model,
})
export type Model = typeof Model.Type

export const popupId = (id: string): string => `${id}-popup`
export const triggerId = (id: string): string => `${id}-trigger`
export const titleId = (id: string): string => `${id}-title`
export const descriptionId = (id: string): string => `${id}-description`

/** `<Dialog defaultOpen>` is `initialModel(id, kind, { isOpen: true })`: open with no enter transition. */
export const initialModel = (id: string, kind: Kind, options: Readonly<{ isOpen?: boolean }> = {}): Model => ({
	id,
	kind,
	isOpen: options.isOpen ?? false,
	animation: PopupTransitionBlock.init({ id: popupId(id), isShowing: options.isOpen ?? false }).model,
})

// MESSAGE

export const Message = defineMessageUnion({
	ClickedTrigger: {},
	ClickedClose: {},
	PressedEscape: {},
	PressedOutside: {},
	CompletedMountDialog: {},
	/** Operation: the parent opens the dialog from code. */
	RequestedOpen: {},
	/** Operation: the parent closes the dialog from code. */
	RequestedClose: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ Opened: {}, Closed: {} })
export type OutMessage = typeof OutMessage.Type

export const DialogDefinition = Block.makeDefinition("Dialog", { Model, Message, OutMessage })

const { makeStep, makeNoopStep, makeFieldsStep } = DialogDefinition

// MOUNT

/** A popup opened from inside the dialog (a select, a menu): its portal is outside the popup but
 * pressing in it is not a press outside the dialog (Base UI's floating tree). */
const nestedPopups = (portal: Element) =>
	`[data-base-ui-portal]:not([data-slot^="toast"])${portal.id === "" ? "" : `:not(#${CSS.escape(portal.id)})`}`

/**
 * On the portal root: moves it to `<body>`, hides the rest of the page from assistive tech,
 * locks scroll, traps focus and moves it in; releasing (unmount) undoes each and returns focus.
 */
export const MountDialog = DialogDefinition.makeMountStream("MountDialog", {
	args: {
		id: Schema.String,
		hasTrigger: Schema.Boolean,
		isPopupFocused: Schema.Boolean,
		isReturningFocus: Schema.Boolean,
	},
	messages: [Message.CompletedMountDialog, Message.PressedOutside, Message.PressedEscape],
	handler: function* () {
		return ({ element, id, hasTrigger, isPopupFocused, isReturningFocus }) =>
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
							outsidePresses(popup, [nestedPopups(element)]).pipe(Stream.map(() => Message.PressedOutside())),
							strayEscapes(element).pipe(Stream.map(() => Message.PressedEscape())),
						),
					)
				}),
			)
	},
})

/** The handlers this Block owns; `prepareBlock` takes it. */
export const EffectsLayer = MountDialog.layer

// COMPOSITION

// The exit transition ends when the popup's CSS transitions settle (`useOpenChangeComplete`):
// PopupTransitionBlock waits on `#${popupId(id)}` itself once the leave starts.
const AnimationBinding = DialogDefinition.makeBinding(PopupTransitionBlock, { field: "animation", init: false })

export const DialogComposition = DialogDefinition.makeComposition({
	bindings: [AnimationBinding],
	mounts: [MountDialog],
})
export type DialogViewBuilder = Block.ViewBuilderFor<typeof DialogComposition>

// INIT

export const init = DialogComposition.makeInit(
	(id: string, kind: Kind, options: Readonly<{ isOpen?: boolean }> = {}) => ({
		model: initialModel(id, kind, options),
	}),
)

// UPDATE

const showStep = makeStep(() =>
	Update.combineSteps([makeFieldsStep(() => ({ isOpen: () => true })), AnimationBinding.requestShow()]),
)
const hideStep = makeStep(() =>
	Update.combineSteps([makeFieldsStep(() => ({ isOpen: () => false })), AnimationBinding.requestHide()]),
)

// A no-op when already open (closed); the OutMessage reports only a real change.
const openStep = makeStep((model) => (model.isOpen ? makeNoopStep() : showStep))
const closeStep = makeStep((model) => (model.isOpen ? hideStep : makeNoopStep()))
const opened = (isOpen: boolean): OutMessage | undefined => (isOpen ? undefined : OutMessage.Opened())
const closed = (isOpen: boolean): OutMessage | undefined => (isOpen ? OutMessage.Closed() : undefined)

/** An alert dialog ignores presses outside it; Escape and its buttons still close it. */
export const isDismissedByOutsidePress = (kind: Kind): boolean => kind !== "alert-dialog"

export const update = DialogComposition.makeUpdate({
	ClickedTrigger: (model) =>
		model.isOpen
			? pipe(closeStep(model), Update.withOutMessage(closed(model.isOpen)))
			: pipe(openStep(model), Update.withOutMessage(opened(model.isOpen))),
	ClickedClose: (model) => pipe(closeStep(model), Update.withOutMessage(closed(model.isOpen))),
	PressedEscape: (model) => pipe(closeStep(model), Update.withOutMessage(closed(model.isOpen))),
	PressedOutside: (model) =>
		isDismissedByOutsidePress(model.kind)
			? pipe(closeStep(model), Update.withOutMessage(closed(model.isOpen)))
			: makeNoopStep()(model),
	CompletedMountDialog: makeNoopStep(),
	RequestedOpen: (model) => pipe(openStep(model), Update.withOutMessage(opened(model.isOpen))),
	RequestedClose: (model) => pipe(closeStep(model), Update.withOutMessage(closed(model.isOpen))),
})
