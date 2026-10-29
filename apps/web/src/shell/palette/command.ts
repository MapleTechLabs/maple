import { getTracesFacetValues } from "@maple/web-data/warehouse/traces"
import { Effect, Queue, Schema, Stream } from "effect"
import { ReadCache } from "../../data/read-cache"
import { applyScrollOverflow, trackScrollbar } from "../../ui/scroll-area"
import { Message, PaletteDefinition } from "./model"

/** `getTracesFacetValuesResultAtom`'s `staleTime`, counted from the palette closing (its unmount). */
const SERVICES_IDLE_TTL_MS = 30_000
export const SERVICES_OPERATION = "getTracesFacetValues"
export const SERVICES_INPUT = { data: { facet: "service" as const } }

const FacetValues = Schema.Struct({
	data: Schema.Array(Schema.Struct({ name: Schema.String, count: Schema.Number })),
})

/** The palette's service names, through the read cache under the open org. */
export const LoadPaletteServices = PaletteDefinition.makeCommand("LoadPaletteServices", {
	messages: [Message.SucceededLoadServices, Message.FailedLoadServices],
	handler: function* () {
		return () =>
			Effect.gen(function* () {
				const cache = yield* ReadCache
				const response = yield* cache.readInOrg(
					{
						operation: SERVICES_OPERATION,
						input: SERVICES_INPUT,
						idleTtlMs: SERVICES_IDLE_TTL_MS,
						schema: FacetValues,
					},
					getTracesFacetValues(SERVICES_INPUT),
				)
				return Message.SucceededLoadServices({ serviceNames: response.data.map((item) => item.name) })
			}).pipe(Effect.orElseSucceed(() => Message.FailedLoadServices()))
	},
})

const VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]'

/** Keys that move the list's highlight (Base UI's roving keys). */
const ROVING_KEYS: ReadonlySet<string> = new Set([
	"ArrowDown",
	"ArrowUp",
	"Home",
	"End",
	"PageDown",
	"PageUp",
])

/** A `ScrollArea` viewport's overflow (its fades) and measured scrollbar, kept current on scroll and resize. */
const measureViewport = (viewport: HTMLElement, onMeasured: () => void) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const measure = () => applyScrollOverflow(viewport)
			const observer = new ResizeObserver(measure)
			observer.observe(viewport)
			if (viewport.firstElementChild !== null) observer.observe(viewport.firstElementChild)
			viewport.addEventListener("scroll", measure, { passive: true })
			measure()
			const untrack = trackScrollbar(viewport)
			onMeasured()
			return { observer, measure, untrack }
		}),
		(handles) =>
			Effect.sync(() => {
				handles.observer.disconnect()
				viewport.removeEventListener("scroll", handles.measure)
				handles.untrack()
			}),
	)

/** `measureViewport` as a Mount's Stream, `onceMeasured` after the first measure (the shortcuts panel's too). */
export const measuredViewport = <A>(viewport: HTMLElement, onceMeasured: A): Stream.Stream<A> =>
	Stream.callback<A>((queue) =>
		measureViewport(viewport, () => Queue.offerUnsafe(queue, onceMeasured)).pipe(
			Effect.andThen(Effect.never),
		),
	)

/**
 * Base UI keeps focus in the input while an option is pressed, and keeps the highlighted option in
 * view as the arrows move it (`scrollIntoView` nearest); a pointer highlight never scrolls.
 */
const followHighlight = (viewport: HTMLElement) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const keepFocus = (event: Event) => {
				if (event.target instanceof Element && event.target.closest('[role="option"]') !== null)
					event.preventDefault()
			}
			const keyboard = { isMoving: false }
			const onKeyDown = (event: KeyboardEvent) => {
				keyboard.isMoving = ROVING_KEYS.has(event.key)
			}
			const onPointer = () => {
				keyboard.isMoving = false
			}
			const observer = new MutationObserver(() => {
				const highlighted = viewport.querySelector("[data-highlighted]")
				if (!keyboard.isMoving || highlighted === null) return
				keyboard.isMoving = false
				highlighted.scrollIntoView({ block: "nearest" })
			})
			observer.observe(viewport, {
				subtree: true,
				attributes: true,
				attributeFilter: ["data-highlighted"],
			})
			viewport.addEventListener("mousedown", keepFocus)
			viewport.addEventListener("mousemove", onPointer)
			viewport.ownerDocument.addEventListener("keydown", onKeyDown, { capture: true })
			return { observer, keepFocus, onKeyDown, onPointer }
		}),
		(handles) =>
			Effect.sync(() => {
				handles.observer.disconnect()
				viewport.removeEventListener("mousedown", handles.keepFocus)
				viewport.removeEventListener("mousemove", handles.onPointer)
				viewport.ownerDocument.removeEventListener("keydown", handles.onKeyDown, { capture: true })
			}),
	)

/** The list's `ScrollArea` (found under this wrapper): its overflow, its focus and its highlight. */
export const MeasurePaletteList = PaletteDefinition.makeMountStream("MeasurePaletteList", {
	messages: [Message.CompletedMeasureList],
	handler: function* () {
		return ({ element }) => {
			const viewport = element.querySelector(VIEWPORT_SELECTOR)
			if (!(viewport instanceof HTMLElement)) return Stream.empty
			return Stream.callback<typeof Message.CompletedMeasureList.Type>((queue) =>
				Effect.all([
					followHighlight(viewport),
					measureViewport(viewport, () => Queue.offerUnsafe(queue, Message.CompletedMeasureList())),
				]).pipe(Effect.andThen(Effect.never)),
			)
		}
	},
})

const nextFrame = Effect.callback<void>((resume) => {
	requestAnimationFrame(() => resume(Effect.void))
})

/**
 * An action that opens another overlay keeps the palette a few frames, so focus moves on from its
 * input (keeping `:focus-visible`).
 */
export const DelayClose = PaletteDefinition.makeCommand("DelayClose", {
	messages: [Message.ElapsedCloseDelay],
	handler: function* () {
		return () =>
			nextFrame.pipe(
				Effect.andThen(nextFrame),
				Effect.andThen(nextFrame),
				Effect.as(Message.ElapsedCloseDelay()),
			)
	},
})
