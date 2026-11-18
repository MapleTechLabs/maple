import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, Effect, Option, Queue, Schema, Stream } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { type Hsv, hexToHsv, hsvToHex, normalizeHex } from "./color-hsv"
import { input } from "./input"
import { anchorPosition, positionDefaults } from "./overlay/position"

// `ColorPicker`: a swatch that opens a picker for a `#rrggbb` colour. The popup is a native
// `popover`, so the browser owns open, close, Escape and presses outside; the Mount owns the
// picker's HSV (a grey keeps the hue it came from), the drags, the arrow keys and the hex field.

const triggerIdOf = (id: string): string => `${id}-trigger`
const popupIdOf = (id: string): string => `${id}-popup`

/** What the picker's Mount sends: once when mounted, then each picked colour. */
export const ColorPickerMessage = defineMessageUnion({
	CompletedMountColorPicker: {},
	PickedColor: { hex: Schema.String },
})
type ColorPickerMessage = typeof ColorPickerMessage.Type

const hueHex = (hue: number): string => hsvToHex({ hue, saturation: 1, value: 1 })
const WHITE = hsvToHex({ hue: 0, saturation: 0, value: 1 })
const BLACK = hsvToHex({ hue: 0, saturation: 0, value: 0 })
const HUE_RAIL = `linear-gradient(to right, ${Arr.join(Arr.map([0, 60, 120, 180, 240, 300, 360], hueHex), ", ")})`
const AREA = `linear-gradient(to top, ${BLACK}, transparent), linear-gradient(to right, ${WHITE}, var(--color-picker-hue))`

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value))

/** Where a pointer sits across `element`, 0 to 1 on each axis. */
const ratioAt = (element: Element, event: PointerEvent): Readonly<{ x: number; y: number }> => {
	const rect = element.getBoundingClientRect()
	return {
		x: rect.width === 0 ? 0 : clampUnit((event.clientX - rect.left) / rect.width),
		y: rect.height === 0 ? 0 : clampUnit((event.clientY - rect.top) / rect.height),
	}
}

/** The saturation/value square's arrow keys: one percent a press, ten with Shift. */
const areaKey = (hsv: Hsv, key: string, isShift: boolean): Option.Option<Hsv> => {
	const step = isShift ? 0.1 : 0.01
	switch (key) {
		case "ArrowLeft":
			return Option.some({ ...hsv, saturation: clampUnit(hsv.saturation - step) })
		case "ArrowRight":
			return Option.some({ ...hsv, saturation: clampUnit(hsv.saturation + step) })
		case "ArrowUp":
			return Option.some({ ...hsv, value: clampUnit(hsv.value + step) })
		case "ArrowDown":
			return Option.some({ ...hsv, value: clampUnit(hsv.value - step) })
		default:
			return Option.none()
	}
}

/** The hue slider's keys: one degree a press, ten with Shift, Home and End for its ends. */
const hueKey = (hsv: Hsv, key: string, isShift: boolean): Option.Option<Hsv> => {
	const step = isShift ? 10 : 1
	const at = (hue: number) => Option.some({ ...hsv, hue: Math.min(360, Math.max(0, hue)) })
	switch (key) {
		case "ArrowLeft":
		case "ArrowDown":
			return at(hsv.hue - step)
		case "ArrowRight":
		case "ArrowUp":
			return at(hsv.hue + step)
		case "Home":
			return at(0)
		case "End":
			return at(360)
		default:
			return Option.none()
	}
}

/** The picked colour as HSV (a grey keeps its hue) and hex, and the frame a pick waits for. */
type PickerState = { hsv: Hsv; hex: string; frame: number }

/** Listens until the returned release runs. */
const on = <K extends keyof HTMLElementEventMap>(
	target: HTMLElement,
	type: K,
	listener: (event: HTMLElementEventMap[K]) => void,
): (() => void) => {
	target.addEventListener(type, listener)
	return () => target.removeEventListener(type, listener)
}

/** The picker's own state and input: drags, keys, the hex field and presets. Emits once a frame. */
const picks = (popup: HTMLElement, triggerId: string): Stream.Stream<ColorPickerMessage> =>
	Stream.callback<ColorPickerMessage>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const area = popup.querySelector("[data-slot=color-picker-area]")
				const hue = popup.querySelector("[data-slot=color-picker-hue]")
				const field = popup.querySelector("[data-slot=color-picker-hex] input")
				if (!(area instanceof HTMLElement) || !(hue instanceof HTMLElement)) return () => undefined
				const hexField = field instanceof HTMLInputElement ? field : null
				const state: PickerState = {
					hsv: { hue: 0, saturation: 0, value: 0 },
					hex: "",
					frame: 0,
				}
				const paint = () => {
					popup.style.setProperty("--color-picker-hue", hueHex(state.hsv.hue))
					popup.style.setProperty("--color-picker-color", state.hex)
					popup.style.setProperty("--color-picker-x", `${state.hsv.saturation * 100}%`)
					popup.style.setProperty("--color-picker-y", `${(1 - state.hsv.value) * 100}%`)
					popup.style.setProperty("--color-picker-hue-x", `${(state.hsv.hue / 360) * 100}%`)
					// The number is the horizontal axis (saturation); the text names both axes.
					area.setAttribute("aria-valuenow", String(Math.round(state.hsv.saturation * 100)))
					area.setAttribute(
						"aria-valuetext",
						`Saturation ${Math.round(state.hsv.saturation * 100)}%, brightness ${Math.round(state.hsv.value * 100)}%`,
					)
					hue.setAttribute("aria-valuenow", String(Math.round(state.hsv.hue)))
					if (hexField !== null && document.activeElement !== hexField) hexField.value = state.hex
				}
				/** The picked colour from the page's `value`; the same colour keeps the hue it had. */
				const syncFromValue = () => {
					const value = popup.getAttribute("data-value") ?? ""
					if (Option.contains(normalizeHex(value), state.hex)) return paint()
					Option.map(hexToHsv(value, state.hsv), (hsv) => {
						state.hsv = hsv
						state.hex = hsvToHex(hsv)
					})
					paint()
				}
				const emit = () => {
					if (state.frame !== 0) return
					state.frame = requestAnimationFrame(() => {
						state.frame = 0
						Queue.offerUnsafe(queue, ColorPickerMessage.PickedColor({ hex: state.hex }))
					})
				}
				const pick = (hsv: Hsv) => {
					state.hsv = hsv
					state.hex = hsvToHex(hsv)
					paint()
					emit()
				}
				const pickHex = (text: string) =>
					Option.map(hexToHsv(text, state.hsv), (hsv) => {
						state.hsv = hsv
						state.hex = Option.getOrElse(normalizeHex(text), () => hsvToHex(hsv))
						paint()
						emit()
					})
				const pickArea = (event: PointerEvent) => {
					const { x, y } = ratioAt(area, event)
					pick({ ...state.hsv, saturation: x, value: 1 - y })
				}
				const pickHue = (event: PointerEvent) => pick({ ...state.hsv, hue: ratioAt(hue, event).x * 360 })
				const dragging = (target: HTMLElement, onPoint: (event: PointerEvent) => void) => ({
					down: (event: PointerEvent) => {
						if (event.button !== 0) return
						event.preventDefault()
						target.setPointerCapture(event.pointerId)
						target.focus()
						onPoint(event)
					},
					move: (event: PointerEvent) => {
						if (target.hasPointerCapture(event.pointerId)) onPoint(event)
					},
				})
				const areaDrag = dragging(area, pickArea)
				const hueDrag = dragging(hue, pickHue)
				const keyed =
					(step: (hsv: Hsv, key: string, isShift: boolean) => Option.Option<Hsv>) =>
					(event: KeyboardEvent) =>
						Option.map(step(state.hsv, event.key, event.shiftKey), (hsv) => {
							event.preventDefault()
							pick(hsv)
						})
				const onAreaKey = keyed(areaKey)
				const onHueKey = keyed(hueKey)
				const onFieldInput = () => {
					if (hexField !== null) pickHex(hexField.value)
				}
				const onFieldChange = () => {
					if (hexField !== null) hexField.value = state.hex
				}
				const onFieldKey = (event: KeyboardEvent) => {
					// Enter commits the field instead of submitting a surrounding form.
					if (event.key === "Enter") {
						event.preventDefault()
						onFieldChange()
					}
				}
				const onPresetClick = (event: MouseEvent) => {
					const preset =
						event.target instanceof Element ? event.target.closest("[data-color-picker-preset]") : null
					const color = preset?.getAttribute("data-color-picker-preset")
					if (color != null) pickHex(color)
				}
				// Escape closes the picker only: a surrounding sheet or dialog keeps its own Escape.
				const onPopupKey = (event: KeyboardEvent) => {
					if (event.key !== "Escape") return
					event.preventDefault()
					event.stopPropagation()
					popup.hidePopover()
					document.getElementById(triggerId)?.focus()
				}
				const onBeforeToggle = () => {
					if (!popup.matches(":popover-open")) syncFromValue()
				}
				syncFromValue()
				const releases = [
					on(area, "pointerdown", areaDrag.down),
					on(area, "pointermove", areaDrag.move),
					on(area, "keydown", onAreaKey),
					on(hue, "pointerdown", hueDrag.down),
					on(hue, "pointermove", hueDrag.move),
					on(hue, "keydown", onHueKey),
					...(hexField === null
						? []
						: [
								on(hexField, "input", onFieldInput),
								on(hexField, "change", onFieldChange),
								on(hexField, "keydown", onFieldKey),
							]),
					on(popup, "click", onPresetClick),
					on(popup, "keydown", onPopupKey),
					on(popup, "beforetoggle", onBeforeToggle),
				]
				return () => {
					cancelAnimationFrame(state.frame)
					for (const release of releases) release()
				}
			}),
			(release) => Effect.sync(release),
		).pipe(Effect.andThen(Effect.never)),
	)

/** Whether the popup is open, on every toggle. */
const openings = (popup: HTMLElement): Stream.Stream<boolean> =>
	Stream.callback<boolean>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const onToggle = () => Queue.offerUnsafe(queue, popup.matches(":popover-open"))
				popup.addEventListener("toggle", onToggle)
				return onToggle
			}),
			(onToggle) => Effect.sync(() => popup.removeEventListener("toggle", onToggle)),
		).pipe(Effect.andThen(Effect.never)),
	)

/** Pointer drags, keys, the hex field and placement under the swatch while open. */
export const MountColorPicker = Mount.defineStream("MountColorPicker", {
	args: { triggerId: Schema.String },
	messages: [ColorPickerMessage.CompletedMountColorPicker, ColorPickerMessage.PickedColor],
	execute: ({ element, triggerId }) => {
		if (!(element instanceof HTMLElement)) return Stream.empty
		const placement = openings(element).pipe(
			Stream.switchMap((isOpen) =>
				isOpen
					? anchorPosition(element, {
							...positionDefaults,
							anchor: { _tag: "Element", id: triggerId },
							side: "bottom",
							align: "start",
							sideOffset: 4,
							positionMethod: "fixed",
						}).pipe(Stream.drain)
					: Stream.empty,
			),
		)
		return Stream.concat(
			Stream.make(ColorPickerMessage.CompletedMountColorPicker()),
			Stream.merge(picks(element, triggerId), placement),
		)
	},
})

export type ColorPickerOptions<M> = Readonly<{
	/** Unique on the page: the trigger's and popup's ids. A new id remounts the picker. */
	id: string
	/** The colour, `#rrggbb`. */
	value: string
	/** Accessible name ("Threshold color"). */
	label: string
	/**
	 * The picked colour, lower-case `#rrggbb`, at most once a frame while dragging. Captured when
	 * the picker mounts, like any Mount: what it writes to must follow `id`.
	 */
	onInput: (color: string) => M
	/** Sent once the picker is mounted; most pages ignore it. Scene tests resolve `MountColorPicker` with it. */
	onMount: M
	/** Colours offered as one-press swatches under the picker. */
	presets?: ReadonlyArray<string>
	/** The trigger swatch's classes. */
	className?: string
}>

const TRIGGER =
	"relative size-8 shrink-0 cursor-pointer rounded-sm border bg-transparent p-0.5 outline-none hover:border-border-strong active:border-border-strong focus-visible:ring-2 focus-visible:ring-ring"
const POPUP =
	"inset-auto m-0 w-60 overflow-visible rounded-lg border bg-popover p-3 text-popover-foreground shadow-popup outline-none transition-[opacity,scale] duration-100 starting:scale-98 starting:opacity-0"
const SLIDER_FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-ring"
const THUMB =
	"pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-raised"

/**
 * `ColorPicker`: a swatch that opens a saturation/value square, a hue slider, a hex field and
 * optional preset swatches, reporting the picked `#rrggbb` colour. No Model: the browser's
 * `popover` holds open and closed.
 */
export const colorPicker = <M>(h: HtmlBuilder<M>, options: ColorPickerOptions<M>): Html => {
	const triggerId = triggerIdOf(options.id)
	const popupId = popupIdOf(options.id)
	const presets = options.presets ?? []
	return h.div(
		[h.Key(options.id), h.Class("contents"), h.DataAttribute("slot", "color-picker")],
		[
			h.button(
				[
					h.Type("button"),
					h.Id(triggerId),
					h.Popovertarget(popupId),
					h.AriaLabel(options.label),
					h.AriaHasPopup("dialog"),
					h.Class(cn(TRIGGER, options.className)),
					h.DataAttribute("slot", "color-picker-trigger"),
				],
				[
					h.span([
						h.Class("block size-full rounded-xs"),
						h.Style({ "background-color": options.value }),
					]),
				],
			),
			h.div(
				[
					h.Id(popupId),
					h.Popover("auto"),
					h.Role("dialog"),
					h.AriaLabel(options.label),
					h.Class(POPUP),
					h.DataAttribute("slot", "color-picker-popup"),
					h.DataAttribute("value", options.value),
					h.OnMount(
						Mount.mapMessage(MountColorPicker({ triggerId }), (message) =>
							message._tag === "PickedColor" ? options.onInput(message.hex) : options.onMount,
						),
					),
				],
				[
					h.div(
						[h.Class("flex flex-col gap-3")],
						[
							h.div(
								[
									h.Class(
										cn(
											"relative h-36 w-full cursor-crosshair touch-none rounded-sm",
											SLIDER_FOCUS,
										),
									),
									h.Style({ background: AREA }),
									h.Role("slider"),
									h.AriaLabel("Saturation and brightness"),
									h.AriaValuemin(0),
									h.AriaValuemax(100),
									h.Tabindex(0),
									h.DataAttribute("slot", "color-picker-area"),
								],
								[
									h.span([
										h.Class(
											cn(
												THUMB,
												"top-(--color-picker-y) left-(--color-picker-x) bg-(--color-picker-color)",
											),
										),
										h.Style({ "border-color": WHITE }),
									]),
								],
							),
							h.div(
								[
									h.Class(cn("relative h-3 w-full cursor-pointer touch-none rounded-full", SLIDER_FOCUS)),
									h.Style({ background: HUE_RAIL }),
									h.Role("slider"),
									h.AriaLabel("Hue"),
									h.AriaValuemin(0),
									h.AriaValuemax(360),
									h.Tabindex(0),
									h.DataAttribute("slot", "color-picker-hue"),
								],
								[
									h.span([
										h.Class(cn(THUMB, "top-1/2 left-(--color-picker-hue-x) bg-(--color-picker-hue)")),
										h.Style({ "border-color": WHITE }),
									]),
								],
							),
							h.div(
								[h.Class("flex items-center gap-2"), h.DataAttribute("slot", "color-picker-hex")],
								[
									h.span([
										h.Class("size-8 shrink-0 rounded-sm border bg-(--color-picker-color)"),
									]),
									input(h, {
										id: `${options.id}-hex`,
										size: "sm",
										className: "min-w-0 grow",
										controlClassName: "font-mono",
										attributes: [
											h.AriaLabel("Hex color"),
											h.Maxlength(7),
											h.Spellcheck(false),
											h.Autocomplete("off"),
										],
									}),
								],
							),
							...(presets.length === 0
								? []
								: [
										h.div(
											[h.Class("flex flex-wrap gap-1.5"), h.AriaLabel("Presets"), h.Role("group")],
											Arr.map(presets, (preset) =>
												h.button(
													[
														h.Key(preset),
														h.Type("button"),
														h.AriaLabel(preset),
														h.Class(
															"size-5 cursor-pointer rounded-xs border outline-none hover:border-border-strong active:border-border-strong focus-visible:ring-2 focus-visible:ring-ring",
														),
														h.Style({ "background-color": preset }),
														h.DataAttribute("color-picker-preset", preset),
													],
													[],
												),
											),
										),
									]),
						],
					),
				],
			),
		],
	)
}
