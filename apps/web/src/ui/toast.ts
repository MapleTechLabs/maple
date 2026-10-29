import { Array, Duration, Effect, Layer, Number, Option, Queue, Schema, Stream } from "effect"
import { Block, Dom, Render } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { portalToBody } from "./overlay/portal"

/**
 * The toast manager of `@maple/ui/toast` (Base UI Toast) as a Block the app root binds: one
 * list, newest first, with Base UI's limit, timeouts, measured heights and enter/exit transitions.
 * `toast-view.ts` completes `ToastBlock` with the two "Notifications" regions every page has.
 */

// MODEL

export const ToastType = Schema.Literals(["default", "success", "error", "info", "warning", "loading"])
export type ToastType = typeof ToastType.Type

export const Phase = Schema.Literals(["Starting", "Open", "Ending"])
export type Phase = typeof Phase.Type

export const Toast = Schema.Struct({
	id: Schema.String,
	type: ToastType,
	title: Schema.String,
	description: Schema.String,
	timeoutMs: Schema.Number,
	height: Schema.NullOr(Schema.Number),
	phase: Phase,
	/** `actionProps.children`: the label of the toast's action button, if it has one. */
	actionLabel: Schema.NullOr(Schema.String),
})
export type Toast = typeof Toast.Type

export const Model = Schema.Struct({
	id: Schema.String,
	nextKey: Schema.Number,
	toasts: Schema.Array(Toast),
	isHovering: Schema.Boolean,
	isFocused: Schema.Boolean,
})
export type Model = typeof Model.Type

/** `ToastProvider` defaults: 5 s timeout, 3 visible. */
export const DEFAULT_TIMEOUT_MS = 5000
export const LIMIT = 3

/** The empty stack `ToastBlock.init(id)` starts from. */
export const initialModel = (id: string): Model => ({
	id,
	nextKey: 0,
	toasts: [],
	isHovering: false,
	isFocused: false,
})

export const titleId = (toastId: string): string => `${toastId}-title`
export const descriptionId = (toastId: string): string => `${toastId}-description`
const rootSelector = (toastId: string) => `[aria-labelledby="${CSS.escape(titleId(toastId))}"]`

// MESSAGE

export const Message = defineMessageUnion({
	CompletedPortalToasts: {},
	CompletedToastEnter: { toastId: Schema.String },
	MeasuredToast: { toastId: Schema.String, height: Schema.Number },
	ElapsedToastTimeout: { toastId: Schema.String },
	ClickedToastClose: { toastId: Schema.String },
	/** The action button; the toast's owner runs the action (the app root, for a page's toast). */
	ClickedToastAction: { toastId: Schema.String },
	/** `toastManager.add` (the `requestAdd` operation); `nextToastId` is the id it gets. */
	RequestedAdd: {
		type: Schema.optionalKey(ToastType),
		title: Schema.String,
		description: Schema.String,
		/** Milliseconds; 0 keeps the toast until it is closed. */
		timeoutMs: Schema.optionalKey(Schema.Number),
		/** An action button (`actionProps`); its click reaches the owner as `ClickedToastAction`. */
		actionLabel: Schema.optionalKey(Schema.String),
	},
	/** `toastManager.close` (the `requestClose` operation). */
	RequestedClose: { toastId: Schema.String },
	PressedToastEscape: { toastId: Schema.String },
	EndedToastTransition: { toastId: Schema.String },
	EnteredViewport: {},
	LeftViewport: {},
	FocusedViewport: {},
	BlurredViewport: {},
})
export type Message = typeof Message.Type

/** What the owner acts on: a toast's action button, and a toast leaving the list for good. */
export const OutMessage = defineMessageUnion({
	ClickedToastAction: { toastId: Schema.String },
	RemovedToast: { toastId: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

export const ToastDefinition = Block.makeDefinition("Toast", { Model, Message, OutMessage })

const { makeStep } = ToastDefinition

// COMMAND

/** Drops `data-starting-style` once the toast has painted, so its enter transition runs. */
export const WaitForToastPaint = ToastDefinition.makeCommand("WaitForToastPaint", {
	args: { toastId: Schema.String },
	messages: [Message.CompletedToastEnter],
	handler: function* () {
		return ({ toastId }) => Render.afterPaint.pipe(Effect.as(Message.CompletedToastEnter({ toastId })))
	},
})

export const WaitToastTimeout = ToastDefinition.makeCommand("WaitToastTimeout", {
	args: { toastId: Schema.String, timeoutMs: Schema.Number },
	messages: [Message.ElapsedToastTimeout],
	handler: function* () {
		return ({ toastId, timeoutMs }) =>
			Effect.sleep(Duration.millis(timeoutMs)).pipe(Effect.as(Message.ElapsedToastTimeout({ toastId })))
	},
})

/** `useOpenChangeComplete`: the toast leaves the list when its exit transition settles. */
export const WaitForToastExit = ToastDefinition.makeCommand("WaitForToastExit", {
	args: { toastId: Schema.String },
	messages: [Message.EndedToastTransition],
	handler: function* () {
		return ({ toastId }) =>
			Dom.waitForAnimationSettled(rootSelector(toastId)).pipe(
				Effect.as(Message.EndedToastTransition({ toastId })),
			)
	},
})

// MOUNT

/** `Toast.Portal`: each region lives at the end of `<body>`. */
export const PortalToasts = ToastDefinition.makeMount("PortalToasts", {
	messages: [Message.CompletedPortalToasts],
	handler: function* () {
		return ({ element }) => portalToBody(element).pipe(Effect.as(Message.CompletedPortalToasts()))
	},
})

/** `recalculateHeight`: the natural height (with `height: auto`), again whenever the content resizes. */
const measure = (root: HTMLElement): number => {
	const previous = root.style.height
	root.style.height = "auto"
	const height = root.offsetHeight
	root.style.height = previous
	return height
}

export const MeasureToast = ToastDefinition.makeMountStream("MeasureToast", {
	args: { toastId: Schema.String },
	messages: [Message.MeasuredToast],
	handler: function* () {
		return ({ element, toastId }) =>
			Stream.callback<typeof Message.MeasuredToast.Type>((queue) =>
				Effect.acquireRelease(
					Effect.sync(() => {
						const observer = new ResizeObserver(() => {
							if (element instanceof HTMLElement)
								Queue.offerUnsafe(
									queue,
									Message.MeasuredToast({ toastId, height: measure(element) }),
								)
						})
						if (element.firstElementChild !== null) observer.observe(element.firstElementChild)
						return observer
					}),
					(observer) => Effect.sync(() => observer.disconnect()),
				).pipe(Effect.andThen(Effect.never)),
			)
	},
})

export const ToastComposition = ToastDefinition.makeComposition({ mounts: [PortalToasts, MeasureToast] })

/** Every handler the toast Block owns, for `prepareBlock` in `toast-view.ts`. */
export const EffectsLayer = Layer.mergeAll(
	WaitForToastPaint.layer,
	WaitToastTimeout.layer,
	WaitForToastExit.layer,
	PortalToasts.layer,
	MeasureToast.layer,
)

// UPDATE

export type AddOptions = Readonly<{
	type?: ToastType
	title: string
	description: string
	/** Milliseconds; 0 keeps the toast until it is closed. */
	timeoutMs?: number
	/** An action button (`actionProps`); its click is the owner's to handle (`ClickedToastAction`). */
	actionLabel?: string
}>

/** The id `requestAdd` gives the next toast, so an owner can remember what its action does. */
export const nextToastId = (model: Model): string => `${model.id}-${model.nextKey}`

/** `toastManager.add`: the new toast goes first and starts its enter transition. */
const addStep = makeStep((model, options: AddOptions) => {
	const toastId = nextToastId(model)
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const toast: Toast = {
		id: toastId,
		type: options.type ?? "default",
		title: options.title,
		description: options.description,
		timeoutMs,
		height: null,
		phase: "Starting",
		actionLabel: options.actionLabel ?? null,
	}
	return {
		model: modifyFields(model, { nextKey: Number.increment, toasts: Array.prepend(toast) }),
		commands: [
			WaitForToastPaint({ toastId }),
			...(timeoutMs > 0 ? [WaitToastTimeout({ toastId, timeoutMs })] : []),
		],
	}
})

const withToast = (model: Model, toastId: string, f: (toast: Toast) => Toast): Model =>
	modifyFields(model, { toasts: Array.map((toast) => (toast.id === toastId ? f(toast) : toast)) })

/** `toastManager.close`: the toast plays its exit transition, then leaves the list. */
const closeStep = makeStep((model, toastId: string) =>
	Option.match(
		Array.findFirst(model.toasts, (toast) => toast.id === toastId && toast.phase !== "Ending"),
		{
			onNone: () => ({ model }),
			onSome: () => ({
				model: withToast(model, toastId, (toast) => ({ ...toast, phase: "Ending" })),
				commands: [WaitForToastExit({ toastId })],
			}),
		},
	),
)

/** Hovering or focusing the region expands the stack and holds the timers. */
export const isExpanded = (model: Model): boolean => model.isHovering || model.isFocused

export const init = ToastComposition.makeInit((id: string) => ({ model: initialModel(id) }))

export const update = ToastComposition.makeUpdate({
	CompletedPortalToasts: (model) => ({ model }),
	CompletedToastEnter: (model, { toastId }) => ({
		model: withToast(model, toastId, (toast) =>
			toast.phase === "Starting" ? { ...toast, phase: "Open" } : toast,
		),
	}),
	MeasuredToast: (model, { toastId, height }) => ({
		model: withToast(model, toastId, (toast) =>
			toast.phase === "Ending" ? toast : { ...toast, height },
		),
	}),
	ElapsedToastTimeout: (model, { toastId }) =>
		isExpanded(model)
			? Option.match(
					Array.findFirst(model.toasts, (toast) => toast.id === toastId),
					{
						onNone: () => ({ model }),
						onSome: (toast) => ({
							model,
							commands: [WaitToastTimeout({ toastId, timeoutMs: toast.timeoutMs })],
						}),
					},
				)
			: closeStep(model, toastId),
	ClickedToastClose: (model, { toastId }) => closeStep(model, toastId),
	ClickedToastAction: (model, { toastId }) => ({
		model,
		outMessage: OutMessage.ClickedToastAction({ toastId }),
	}),
	RequestedAdd: (model, options) => addStep(model, options),
	RequestedClose: (model, { toastId }) => closeStep(model, toastId),
	PressedToastEscape: (model, { toastId }) => closeStep(model, toastId),
	EndedToastTransition: (model, { toastId }) => ({
		model: modifyFields(model, { toasts: Array.filter((toast) => toast.id !== toastId) }),
		outMessage: OutMessage.RemovedToast({ toastId }),
	}),
	EnteredViewport: (model) => ({ model: modifyFields(model, { isHovering: () => true }) }),
	LeftViewport: (model) => ({ model: modifyFields(model, { isHovering: () => false }) }),
	FocusedViewport: (model) => ({ model: modifyFields(model, { isFocused: () => true }) }),
	BlurredViewport: (model) => ({ model: modifyFields(model, { isFocused: () => false }) }),
})
