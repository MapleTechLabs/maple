import { cn } from "@maple/ui/lib/utils"
import {
	resizableHandleGripStyles,
	resizableHandleStyles,
	resizablePanelGroupStyles,
	resizablePanelStyles,
} from "@maple/ui/styles/ui/resizable"
import { Array, Effect, Number, Option, Queue, Schema, Stream } from "effect"
import { Mount, Submodel, type Update } from "foldkit"
import type { Html } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"

/**
 * `react-resizable-panels` 4 (`@maple/ui/resizable`): one panel group, sizes in percent. Dragging
 * a handle moves the boundary between its two panels (the Mount turns pointer moves into
 * percent deltas from the drag start); arrows move it by 5, Home and End to the ends.
 */

// MODEL

export const Orientation = Schema.Literals(["horizontal", "vertical"])
export type Orientation = typeof Orientation.Type

export const Drag = Schema.Struct({ handleIndex: Schema.Number, startLayout: Schema.Array(Schema.Number) })

export const Model = Schema.Struct({
	id: Schema.String,
	orientation: Orientation,
	/** Panel sizes in percent, summing to 100 (`defaultSize`). */
	layout: Schema.Array(Schema.Number),
	drag: Schema.NullOr(Drag),
	focusedHandle: Schema.NullOr(Schema.Number),
})
export type Model = typeof Model.Type

export const KEYBOARD_STEP = 5

export const panelId = (id: string, index: number): string => `${id}-panel-${index}`
export const handleId = (id: string, index: number): string => `${id}-handle-${index}`

export const init = (id: string, orientation: Orientation, layout: ReadonlyArray<number>): Model => ({
	id,
	orientation,
	layout,
	drag: null,
	focusedHandle: null,
})

// MESSAGE

export const Message = defineMessageUnion({
	StartedDrag: { handleIndex: Schema.Number },
	Dragged: { deltaPercent: Schema.Number },
	EndedDrag: {},
	PressedHandleKey: { handleIndex: Schema.Number, key: Schema.String },
	FocusedHandle: { handleIndex: Schema.Number },
	BlurredHandle: {},
})
export type Message = typeof Message.Type

// UPDATE

/** The library's `parseFloat(toFixed(3))` precision. */
const precise = (value: number): number => parseFloat(value.toFixed(3))

/** Moves the boundary after panel `handleIndex` by `delta` percent, within the pair's total. */
export const resize = (
	layout: ReadonlyArray<number>,
	handleIndex: number,
	delta: number,
): ReadonlyArray<number> => {
	const before = layout[handleIndex]
	const after = layout[handleIndex + 1]
	if (before === undefined || after === undefined) return layout
	const total = before + after
	const next = precise(Number.clamp(before + delta, { minimum: 0, maximum: total }))
	return layout.map((size, index) =>
		index === handleIndex ? next : index === handleIndex + 1 ? precise(total - next) : size,
	)
}

const keyDelta = (orientation: Orientation, key: string): Option.Option<number> => {
	if (key === "Home") return Option.some(-100)
	if (key === "End") return Option.some(100)
	const [decrease, increase] =
		orientation === "horizontal" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"]
	return key === decrease
		? Option.some(-KEYBOARD_STEP)
		: key === increase
			? Option.some(KEYBOARD_STEP)
			: Option.none()
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		StartedDrag: ({ handleIndex }) => ({
			model: { ...model, drag: { handleIndex, startLayout: model.layout } },
		}),
		Dragged: ({ deltaPercent }) =>
			model.drag === null
				? { model }
				: {
						model: {
							...model,
							layout: resize(model.drag.startLayout, model.drag.handleIndex, deltaPercent),
						},
					},
		EndedDrag: () => ({ model: { ...model, drag: null } }),
		PressedHandleKey: ({ handleIndex, key }) =>
			Option.match(keyDelta(model.orientation, key), {
				onNone: () => ({ model }),
				onSome: (delta) => ({
					model: { ...model, layout: resize(model.layout, handleIndex, delta) },
				}),
			}),
		FocusedHandle: ({ handleIndex }) => ({ model: { ...model, focusedHandle: handleIndex } }),
		BlurredHandle: () => ({ model: { ...model, focusedHandle: null } }),
	})

// MOUNT

type DragMessage =
	| ReturnType<typeof Message.StartedDrag>
	| ReturnType<typeof Message.Dragged>
	| ReturnType<typeof Message.EndedDrag>

/** This group's own handles (a nested group's handles are its own). */
const ownHandles = (group: Element): ReadonlyArray<Element> =>
	Array.filter(Array.fromIterable(group.children), (child) => child.hasAttribute("data-separator"))

/**
 * Pointer drags on the group's handles: the press reports the handle, each move the percent
 * moved along the group's axis since the press, the release the end.
 */
export const MountResizeGroup = Mount.defineStream("MountResizeGroup", {
	args: { orientation: Orientation },
	messages: [Message.StartedDrag, Message.Dragged, Message.EndedDrag],
	execute: ({ element, orientation }) =>
		Stream.callback<DragMessage>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const isHorizontal = orientation === "horizontal"
					const drag = { start: 0, size: 1, isActive: false }
					const onMove = (event: PointerEvent) => {
						if (!drag.isActive) return
						const position = isHorizontal ? event.clientX : event.clientY
						Queue.offerUnsafe(
							queue,
							Message.Dragged({ deltaPercent: ((position - drag.start) / drag.size) * 100 }),
						)
					}
					const onUp = () => {
						if (!drag.isActive) return
						drag.isActive = false
						Queue.offerUnsafe(queue, Message.EndedDrag())
					}
					const onDown = (event: Event) => {
						if (!(event instanceof PointerEvent)) return
						const handle =
							event.target instanceof Element ? event.target.closest("[data-separator]") : null
						const handleIndex = handle === null ? -1 : ownHandles(element).indexOf(handle)
						if (handleIndex === -1) return
						const box = element.getBoundingClientRect()
						drag.start = isHorizontal ? event.clientX : event.clientY
						drag.size = Math.max(1, isHorizontal ? box.width : box.height)
						drag.isActive = true
						event.preventDefault()
						Queue.offerUnsafe(queue, Message.StartedDrag({ handleIndex }))
					}
					element.addEventListener("pointerdown", onDown)
					document.addEventListener("pointermove", onMove)
					document.addEventListener("pointerup", onUp)
					return () => {
						element.removeEventListener("pointerdown", onDown)
						document.removeEventListener("pointermove", onMove)
						document.removeEventListener("pointerup", onUp)
					}
				}),
				(stop) => Effect.sync(stop),
			).pipe(Effect.andThen(Effect.never)),
		),
})

// VIEW

export type ViewInputs = Readonly<{
	/** Each panel's content, in order (a callback, so a panel can hold a nested group); `layout` holds the sizes. */
	toPanels: () => ReadonlyArray<ReadonlyArray<Html>>
	/** `<ResizableHandle withHandle>` for the handle after each panel but the last. */
	withHandle: ReadonlyArray<boolean>
	className?: string
}>

const HANDLE_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"])

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const panels = inputs.toPanels()
	const isHorizontal = model.orientation === "horizontal"
	const touchAction = isHorizontal ? "pan-y" : "pan-x"
	const panel = (content: ReadonlyArray<Html>, index: number): Html =>
		h.div(
			[
				h.DataAttribute("panel", "true"),
				h.DataAttribute("slot", "resizable-panel"),
				h.DataAttribute("testid", panelId(model.id, index)),
				h.Id(panelId(model.id, index)),
				h.Style({
					minHeight: "0px",
					maxHeight: "100%",
					height: "auto",
					minWidth: "0px",
					maxWidth: "100%",
					width: "auto",
					border: "0px",
					padding: "0px",
					margin: "0px",
					display: "flex",
					flex: `${model.layout[index] ?? 1} 1 0px`,
					overflow: "visible",
				}),
			],
			[
				h.div(
					[
						h.Class(cn(resizablePanelStyles)),
						h.Style({
							maxHeight: "100%",
							maxWidth: "100%",
							flexGrow: "1",
							overflow: "auto",
							touchAction,
						}),
					],
					content,
				),
			],
		)
	const handle = (index: number): Html =>
		h.div(
			[
				h.AriaControls(panelId(model.id, index)),
				h.AriaOrientation(isHorizontal ? "vertical" : "horizontal"),
				h.Attribute("aria-valuemax", "100"),
				h.Attribute("aria-valuemin", "0"),
				h.Attribute("aria-valuenow", String(Math.round(model.layout[index] ?? 0))),
				h.Class(cn(resizableHandleStyles)),
				h.DataAttribute(
					"separator",
					model.drag?.handleIndex === index
						? "active"
						: model.focusedHandle === index
							? "focus"
							: "inactive",
				),
				h.DataAttribute("slot", "resizable-handle"),
				h.DataAttribute("testid", handleId(model.id, index)),
				h.Id(handleId(model.id, index)),
				h.Role("separator"),
				h.Style({ flex: "0 0 auto", touchAction: "none" }),
				h.Tabindex(0),
				h.OnFocus(Message.FocusedHandle({ handleIndex: index })),
				h.OnBlur(Message.BlurredHandle()),
				h.OnKeyDownPreventDefault((key) =>
					HANDLE_KEYS.has(key)
						? Option.some(Message.PressedHandleKey({ handleIndex: index, key }))
						: Option.none(),
				),
			],
			(inputs.withHandle[index] ?? false) ? [h.div([h.Class(resizableHandleGripStyles)])] : [],
		)
	return h.div(
		[
			h.Class(cn(resizablePanelGroupStyles, inputs.className)),
			h.DataAttribute("group", "true"),
			h.DataAttribute("slot", "resizable-panel-group"),
			h.DataAttribute("testid", model.id),
			h.Id(model.id),
			h.Style({
				height: "100%",
				width: "100%",
				overflow: "hidden",
				display: "flex",
				flexFlow: isHorizontal ? "row" : "column",
				touchAction,
			}),
			h.OnMount(MountResizeGroup({ orientation: model.orientation })),
		],
		panels.flatMap((content, index) =>
			index === panels.length - 1 ? [panel(content, index)] : [panel(content, index), handle(index)],
		),
	)
})
