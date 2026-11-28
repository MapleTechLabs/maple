import { lockBodyScroll, markOutside, trapFocus } from "@maple/views/ui/overlay/portal"
import { focusGuard, SR_ONLY_STYLE } from "@maple/views/ui/overlay/transition"
import { Array as Arr, Effect, Option, Queue, Result, Schema, Stream, String as Str } from "effect"
import { Command, Mount, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { makeIsland } from "../../foldkit-island/island"
import { captureLandingError, trackLanding } from "../../lib/telemetry"
import { PART } from "./parts"
import type { Viewer, ViewerEvent } from "./viewer"

/**
 * The site's screenshot viewer. The Model holds what is open, `viewer.ts` runs the gestures, and
 * opening or closing renders inside a View Transition that carries the shot to and from its plate.
 * A Foldkit port of ramka (MIT, Copyright (c) 2026 Artur Bień): see ./LICENSE-ramka.
 */

// The static page's side: plates opt in, articles group, and Commands leave the two marks on
// the open gallery's plates so slides and the stylesheet can find them.
const ZOOMABLE = ":is(img, video)[data-zoomable]"
const PROSE_IMAGES = ".docs-content img"
const GROUP = ".docs-content, [data-lightbox-group]"
const TRIGGER = "data-lightbox-trigger"
const ORIGIN = "data-lightbox-origin"

/** Slides this far from the open one keep their image mounted, so a swipe lands on pixels. */
const PRELOAD = 1
/** A gallery this long gets a strip of thumbnails to jump through it. */
const THUMBNAILS_FROM = 5
const KEY_PAN_PX = 50
/** Outlasts the closing transition, which still needs the plate's mark. */
const RELEASE_AFTER = "600 millis"

// MODEL

/**
 * `src` is the full-size file; `preview`, what the plate already shows (its `srcset` pick or a
 * video's poster). A slide opens on the preview, so the morph never waits on the network, and
 * swaps in the full file once it has decoded.
 */
const Item = Schema.Struct({
	kind: Schema.Literals(["image", "video"]),
	src: Schema.String,
	preview: Schema.String,
	/** Pixel widths of the two files, 0 when unknown: the preview is drawn at the full file's size. */
	width: Schema.Number,
	previewWidth: Schema.Number,
	alt: Schema.String,
	caption: Schema.String,
})
type Item = typeof Item.Type

const Model = Schema.Struct({
	items: Schema.Array(Item),
	isOpen: Schema.Boolean,
	index: Schema.Number,
	isZoomed: Schema.Boolean,
	canZoomIn: Schema.Boolean,
	/** Full-size files that have decoded, so their slides show them instead of the preview. */
	decoded: Schema.Array(Schema.String),
	/** Counts closes, so a close's delayed clean-up can tell it is still the latest. */
	closes: Schema.Number,
})
type Model = typeof Model.Type

// MESSAGE

const ViewerKey = Schema.Literals([
	"Escape",
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"ArrowDown",
	"Home",
	"End",
	"+",
	"=",
	"-",
	"_",
	"0",
])
type ViewerKey = typeof ViewerKey.Type

const Message = defineMessageUnion({
	StartedTriggers: {},
	/** `plate` is the pressed image's position among the page's plates; `isReady`, that its bitmap can paint. */
	PressedTrigger: {
		items: Schema.Array(Item),
		index: Schema.Number,
		plate: Schema.Number,
		isReady: Schema.Boolean,
	},
	MountedViewer: {},
	ChangedSlide: { index: Schema.Number },
	ChangedZoom: { isZoomed: Schema.Boolean, canZoomIn: Schema.Boolean },
	PressedKey: { key: ViewerKey },
	DecodedFull: { src: Schema.String },
	ClickedThumbnail: { index: Schema.Number },
	ClickedPrevious: {},
	ClickedNext: {},
	ClickedZoomIn: {},
	ClickedZoomOut: {},
	ClickedClose: {},
	Dismissed: {},
	SettledClose: { closes: Schema.Number },
	CompletedSideEffect: {},
})
type Message = typeof Message.Type

// PLATES

type Plate = HTMLImageElement | HTMLVideoElement

const plates = () => Arr.fromIterable(document.querySelectorAll<Plate>(ZOOMABLE))

const unmark = () =>
	Arr.forEach(Arr.fromIterable(document.querySelectorAll(`[${TRIGGER}], [${ORIGIN}]`)), (plate) => {
		plate.removeAttribute(TRIGGER)
		plate.removeAttribute(ORIGIN)
	})

/**
 * Prose screenshots are worth enlarging too; a linked one keeps its link and a decorative one
 * (an avatar, no alt) stays as it is. Every plate becomes a button the keyboard can reach.
 */
const enlist = () => {
	Arr.forEach(Arr.fromIterable(document.querySelectorAll<HTMLImageElement>(PROSE_IMAGES)), (image) => {
		if (image.closest("a") === null && image.alt !== "") image.dataset["zoomable"] = ""
	})
	Arr.forEach(plates(), (plate) => {
		// A video's description is its `aria-label`, which becomes the button's label below.
		if (plate instanceof HTMLVideoElement && plate.dataset["alt"] === undefined) {
			plate.dataset["alt"] = plate.getAttribute("aria-label") ?? ""
		}
		const alt = altOf(plate)
		plate.tabIndex = 0
		plate.setAttribute("role", "button")
		plate.setAttribute("aria-haspopup", "dialog")
		plate.setAttribute("aria-label", alt === "" ? "Enlarge screenshot" : `Enlarge screenshot: ${alt}`)
	})
}

const altOf = (plate: Plate): string =>
	plate instanceof HTMLImageElement ? plate.alt : (plate.dataset["alt"] ?? "")

/** A `srcset`'s files and their widths, resolved like `currentSrc` so the two compare. */
const candidatesOf = (image: HTMLImageElement): ReadonlyArray<Readonly<{ url: string; width: number }>> =>
	Arr.filterMap(image.srcset.split(","), (entry) => {
		const [url, descriptor] = Str.trim(entry).split(/\s+/)
		const width = Number.parseInt(descriptor ?? "", 10)
		return url === undefined || url === "" || !descriptor?.endsWith("w") || Number.isNaN(width)
			? Result.failVoid
			: Result.succeed({ url: new URL(url, document.baseURI).href, width })
	})

const widthOf = (image: HTMLImageElement, url: string): number =>
	Arr.findFirst(candidatesOf(image), (candidate) => candidate.url === url).pipe(
		Option.map((candidate) => candidate.width),
		Option.getOrElse(() => 0),
	)

/**
 * What the plate paints now: an image's `srcset` pick, a video's poster. A lazy plate not yet
 * scrolled to has picked nothing, so its smallest copy stands in.
 */
const previewOf = (plate: Plate): string => {
	if (plate instanceof HTMLVideoElement) return plate.poster
	if (plate.currentSrc !== "") return plate.currentSrc
	const smallest = Arr.reduce(candidatesOf(plate), Option.none<string>(), (best, candidate) =>
		Option.isSome(best) && widthOf(plate, best.value) <= candidate.width
			? best
			: Option.some(candidate.url),
	)
	return Option.getOrElse(smallest, () => plate.src)
}

/** The full-size file: a `data-zoom-src`, else the plate's own `src` (never its narrower `srcset` pick). */
const sourceOf = (plate: Plate): string => {
	const full = plate.dataset["zoomSrc"] ?? ""
	if (full !== "") return full
	return plate.src !== "" ? plate.src : plate.currentSrc
}

/** A figure's caption sits under its shot; a frame's heading, above it, is not one. */
const captionOf = (image: Plate): string => {
	const caption = image.closest("figure")?.querySelector("figcaption") ?? null
	const isBelow =
		caption !== null && (image.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
	return isBelow ? Str.trim(caption.textContent) : ""
}

/** The shots of the article a plate sits in, in reading order; a plate on its own is a gallery of one. */
const galleryOf = (image: Plate): ReadonlyArray<Plate> => {
	const group = image.closest(GROUP)
	return group === null
		? [image]
		: Arr.filter(
				Arr.fromIterable(group.querySelectorAll<Plate>(ZOOMABLE)),
				(plate) => plate.closest(GROUP) === group,
			)
}

// GESTURES

class LightboxGesturesLoadError extends Schema.TaggedError<LightboxGesturesLoadError>()(
	"@maple/landing/LightboxGesturesLoadError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/**
 * The gesture engine (`viewer.ts`) loads on demand: when a plate is first hovered or focused, and
 * at the latest when one is pressed. A page nobody enlarges never downloads it. A failed load (a
 * deploy since, offline) is forgotten, so the next press tries again.
 */
let gestures: Promise<typeof import("./viewer")> | undefined
const loadGestures = () => {
	gestures ??= import("./viewer").catch((cause: unknown) => {
		gestures = undefined
		// Every press is dropped until a load succeeds: the error is how a dead lightbox shows up.
		captureLandingError(cause, { "maple.landing.component": "lightbox" })
		return Promise.reject(cause)
	})
	return gestures
}

const gesturesModule = Effect.tryPromise({
	try: loadGestures,
	catch: (cause) =>
		new LightboxGesturesLoadError({ message: "Couldn't load the lightbox gestures", cause }),
})

// COMMANDS

const steer = (f: (viewer: Viewer) => void) =>
	gesturesModule.pipe(
		Effect.map(({ viewerOf }) => {
			const viewer = viewerOf(document.querySelector(`[${PART.content}]`))
			if (viewer !== undefined) f(viewer)
		}),
		Effect.ignore,
		Effect.as(Message.CompletedSideEffect()),
	)

/** The track answers with `ChangedSlide` once it has moved, or not at all mid-swipe. */
const GoToSlide = Command.define("GoToLightboxSlide", {
	args: { index: Schema.Number },
	messages: [Message.CompletedSideEffect],
	execute: ({ index }) => steer((viewer) => viewer.goTo(index)),
})

const StepZoom = Command.define("StepLightboxZoom", {
	args: { step: Schema.Literals(["in", "out", "reset"]) },
	messages: [Message.CompletedSideEffect],
	execute: ({ step }) => steer((viewer) => viewer.zoomBy(step)),
})

const PanMedia = Command.define("PanLightboxMedia", {
	args: { dx: Schema.Number, dy: Schema.Number },
	messages: [Message.CompletedSideEffect],
	execute: ({ dx, dy }) => steer((viewer) => viewer.panBy(dx, dy)),
})

/**
 * Marks the accepted press's gallery so slides can find their plates again. The pressed one is
 * the morph's origin only if its bitmap is ready: a transition snapshots the first frame as is.
 */
const MarkTriggers = Command.define("MarkLightboxTriggers", {
	args: { plate: Schema.Number, isReady: Schema.Boolean },
	messages: [Message.CompletedSideEffect],
	execute: ({ plate, isReady }) =>
		Effect.sync(() => {
			const image = plates()[plate]
			unmark()
			if (image !== undefined) {
				Arr.forEach(galleryOf(image), (member, index) => member.setAttribute(TRIGGER, String(index)))
				if (isReady) image.setAttribute(ORIGIN, "")
			}
			return Message.CompletedSideEffect()
		}),
})

const isInView = (element: Element): boolean => {
	const box = element.getBoundingClientRect()
	return box.bottom > 0 && box.top < window.innerHeight
}

/**
 * The plate of the slide on show becomes the one the viewer closes into, and the page scrolls
 * to it behind the backdrop: closing lands on the shot that was being looked at.
 */
const MoveOrigin = Command.define("MoveLightboxOrigin", {
	args: { index: Schema.Number },
	messages: [Message.CompletedSideEffect],
	execute: ({ index }) =>
		Effect.sync(() => {
			const plate = document.querySelector(`[${TRIGGER}="${index}"]`)
			Arr.forEach(Arr.fromIterable(document.querySelectorAll(`[${ORIGIN}]`)), (marked) =>
				marked.removeAttribute(ORIGIN),
			)
			if (plate !== null) {
				plate.setAttribute(ORIGIN, "")
				if (!isInView(plate)) plate.scrollIntoView({ block: "center", behavior: "instant" })
			}
			return Message.CompletedSideEffect()
		}),
})

/** Reports back once a close's transition is over; `update` drops it if the viewer moved on. */
const AwaitClosed = Command.define("AwaitLightboxClosed", {
	args: { closes: Schema.Number },
	messages: [Message.SettledClose],
	execute: ({ closes }) => Effect.as(Effect.sleep(RELEASE_AFTER), Message.SettledClose({ closes })),
})

/** Fetches and decodes a full-size file off screen; the slide swaps it in once it can paint. */
const DecodeFull = Command.define("DecodeLightboxFull", {
	args: { src: Schema.String },
	messages: [Message.DecodedFull, Message.CompletedSideEffect],
	execute: ({ src }) =>
		Effect.promise(() => {
			const full = new Image()
			full.src = src
			// A file that fails to decode would only replace a working preview with a broken image.
			return typeof full.decode === "function"
				? full.decode().then(
						() => true,
						() => false,
					)
				: Promise.resolve(true)
		}).pipe(
			Effect.map((isDecoded) =>
				isDecoded ? Message.DecodedFull({ src }) : Message.CompletedSideEffect(),
			),
		),
})

/** Keeps the open slide's thumbnail in view as the gallery moves. */
const RevealThumbnail = Command.define("RevealLightboxThumbnail", {
	args: { index: Schema.Number, isInstant: Schema.Boolean },
	messages: [Message.CompletedSideEffect],
	execute: ({ index, isInstant }) =>
		Effect.sync(() => {
			const thumbnail = document.querySelector(`[data-lightbox-thumbnail="${index}"]`)
			thumbnail?.scrollIntoView({
				block: "nearest",
				inline: "center",
				behavior: isInstant ? "instant" : "smooth",
			})
			return Message.CompletedSideEffect()
		}),
})

const ReleaseTriggers = Command.define("ReleaseLightboxTriggers", {
	messages: [Message.CompletedSideEffect],
	execute: Effect.sync(() => {
		unmark()
		return Message.CompletedSideEffect()
	}),
})

const ReportOpened = Command.define("ReportLightboxOpened", {
	args: { label: Schema.String },
	messages: [Message.CompletedSideEffect],
	execute: ({ label }) =>
		Effect.sync(() => {
			trackLanding("media_opened", { label: Str.slice(0, 120)(label), path: window.location.pathname })
			return Message.CompletedSideEffect()
		}),
})

// TRIGGERS

/**
 * True when the plate has a frame to morph from: a transition snapshots the first frame as is.
 * A broken image counts as ready; it paints the same empty box either way.
 */
const isReady = (plate: Plate): boolean =>
	plate instanceof HTMLImageElement
		? plate.complete
		: plate.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA

const itemOf = (plate: Plate): Item => {
	const src = sourceOf(plate)
	const preview = previewOf(plate)
	return {
		kind: plate instanceof HTMLVideoElement ? "video" : "image",
		src,
		preview,
		width: plate instanceof HTMLImageElement ? widthOf(plate, new URL(src, document.baseURI).href) : 0,
		previewWidth: plate instanceof HTMLImageElement ? widthOf(plate, preview) : 0,
		alt: altOf(plate),
		caption: captionOf(plate),
	}
}

/**
 * Reads the press off the page. Nothing is marked here: `update` may still turn the press down.
 * Without its gestures the viewer cannot run, so a press whose load failed is dropped.
 */
const present = (plate: Plate): Effect.Effect<Option.Option<typeof Message.PressedTrigger.Type>> => {
	const gallery = galleryOf(plate)
	return Effect.as(
		gesturesModule,
		Message.PressedTrigger({
			items: Arr.map(gallery, itemOf),
			index: gallery.indexOf(plate),
			plate: plates().indexOf(plate),
			isReady: isReady(plate),
		}),
	).pipe(Effect.option)
}

const plateOf = (target: EventTarget | null): Plate | null =>
	(target instanceof HTMLImageElement || target instanceof HTMLVideoElement) && target.matches(ZOOMABLE)
		? target
		: null

const TriggerMessage = Schema.Union([Message.StartedTriggers, Message.PressedTrigger])
type TriggerMessage = typeof TriggerMessage.Type

/** One listener for every plate on the page: they are static markup, not part of this view. */
const ListenForTriggers = Mount.defineStream("ListenForLightboxTriggers", {
	messages: [Message.StartedTriggers, Message.PressedTrigger],
	execute: () =>
		Stream.concat(
			Stream.make<[TriggerMessage]>(Message.StartedTriggers()),
			Stream.callback<Plate>((queue) =>
				Effect.acquireRelease(
					Effect.sync(() => {
						enlist()
						const onClick = (event: MouseEvent) => {
							const plate = plateOf(event.target)
							if (plate !== null) Queue.offerUnsafe(queue, plate)
						}
						// Hover or focus on a plate is a good sign a press follows: fetch the gestures now.
						const onIntent = (event: Event) => {
							if (plateOf(event.target) !== null) void loadGestures().catch(() => undefined)
						}
						const onKeyDown = (event: KeyboardEvent) => {
							const plate = plateOf(event.target)
							if (plate === null || (event.key !== "Enter" && event.key !== " ")) return
							event.preventDefault()
							// A key still held from closing the viewer must not open it again.
							if (!event.repeat) Queue.offerUnsafe(queue, plate)
						}
						document.addEventListener("click", onClick)
						document.addEventListener("keydown", onKeyDown)
						document.addEventListener("pointerover", onIntent, { passive: true })
						document.addEventListener("focusin", onIntent)
						return { onClick, onKeyDown, onIntent }
					}),
					({ onClick, onKeyDown, onIntent }) =>
						Effect.sync(() => {
							document.removeEventListener("click", onClick)
							document.removeEventListener("keydown", onKeyDown)
							document.removeEventListener("pointerover", onIntent)
							document.removeEventListener("focusin", onIntent)
						}),
				).pipe(Effect.andThen(Effect.never)),
			).pipe(
				Stream.mapEffect(present),
				Stream.filterMap((pressed) => Result.fromOption(pressed, () => undefined)),
			),
		),
})

// VIEWER

const ViewerMessage = Schema.Union([
	Message.MountedViewer,
	Message.ChangedSlide,
	Message.ChangedZoom,
	Message.Dismissed,
	Message.PressedKey,
])
type ViewerMessage = typeof ViewerMessage.Type

const fromViewer = (event: ViewerEvent): ViewerMessage => {
	switch (event._tag) {
		case "Slide":
			return Message.ChangedSlide({ index: event.index })
		case "Zoom":
			return Message.ChangedZoom({ isZoomed: event.isZoomed, canZoomIn: event.canZoomIn })
		case "Dismiss":
			return Message.Dismissed()
	}
}

/**
 * Focus lives in the viewer while it is open: it comes back if it lands on the page behind or on
 * nothing (its control was hidden). Closing hands it to the plate the viewer closed into.
 */
const holdFocus = (root: HTMLElement, content: HTMLElement) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const previous = document.activeElement
			const reclaim = () => content.focus({ preventScroll: true })
			const onFocusIn = (event: FocusEvent) => {
				if (event.target instanceof Node && !root.contains(event.target)) reclaim()
			}
			const onFocusOut = (event: FocusEvent) => {
				if (event.relatedTarget !== null) return
				queueMicrotask(() => {
					if (root.isConnected && document.activeElement === document.body) reclaim()
				})
			}
			document.addEventListener("focusin", onFocusIn)
			root.addEventListener("focusout", onFocusOut)
			reclaim()
			return { previous, onFocusIn, onFocusOut }
		}),
		({ previous, onFocusIn, onFocusOut }) =>
			Effect.sync(() => {
				document.removeEventListener("focusin", onFocusIn)
				root.removeEventListener("focusout", onFocusOut)
				const plate = document.querySelector(`[${ORIGIN}]`) ?? previous
				if (plate instanceof HTMLElement && plate.isConnected) plate.focus({ preventScroll: true })
			}),
	)

/**
 * Keys reach the viewer wherever focus sits, and only the viewer: taken in the capture phase and
 * stopped there, so Escape does not also close a panel of the page behind.
 */
const viewerKeys = (offer: (message: ViewerMessage) => void) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const isViewerKey = Schema.is(ViewerKey)
			const onKeyDown = (event: KeyboardEvent) => {
				// A modified key is the browser's: ctrl and + still zooms the page.
				if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
				if (!isViewerKey(event.key)) return
				event.preventDefault()
				event.stopPropagation()
				offer(Message.PressedKey({ key: event.key }))
			}
			document.addEventListener("keydown", onKeyDown, true)
			return onKeyDown
		}),
		(onKeyDown) => Effect.sync(() => document.removeEventListener("keydown", onKeyDown, true)),
	)

/**
 * On the viewer's root while it is open. The gestures start first: the track has to sit on its
 * slide before the opening frame is captured. Then focus, scroll lock and hiding the page.
 */
const MountViewer = Mount.defineStream("MountLightboxViewer", {
	messages: [
		Message.MountedViewer,
		Message.ChangedSlide,
		Message.ChangedZoom,
		Message.Dismissed,
		Message.PressedKey,
	],
	execute: ({ element }) =>
		Stream.callback<ViewerMessage>((queue) =>
			Effect.gen(function* () {
				const offer = (message: ViewerMessage) => {
					Queue.offerUnsafe(queue, message)
				}
				const content = element.querySelector(`[${PART.content}]`)
				if (element instanceof HTMLElement && content instanceof HTMLElement) {
					// Loaded by the press that opened the viewer: this resolves at once.
					const loaded = yield* Effect.option(gesturesModule)
					if (Option.isSome(loaded)) {
						yield* Effect.acquireRelease(
							Effect.sync(() =>
								loaded.value.attachViewer(content, (event) => offer(fromViewer(event))),
							),
							(viewer) => Effect.sync(viewer.dispose),
						)
					}
					yield* holdFocus(element, content)
					yield* trapFocus(element, content)
					yield* viewerKeys(offer)
					yield* lockBodyScroll
					yield* markOutside(element, { mark: true, ariaHidden: true })
				}
				offer(Message.MountedViewer())
				return yield* Effect.never
			}),
		),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

const close = (model: Model): UpdateReturn => {
	if (!model.isOpen) return { model }
	const closes = model.closes + 1
	return { model: { ...model, isOpen: false, closes }, commands: [AwaitClosed({ closes })] }
}

/** The full-size files of the open slide and its mounted neighbours that are not in yet. */
const decodeAround = (items: ReadonlyArray<Item>, index: number, decoded: ReadonlyArray<string>) =>
	Arr.filterMap(items, (item, at) =>
		Math.abs(at - index) <= PRELOAD &&
		item.kind === "image" &&
		item.src !== item.preview &&
		!decoded.includes(item.src)
			? Result.succeed(DecodeFull({ src: item.src }))
			: Result.failVoid,
	)

const hasThumbnails = (model: Model): boolean => model.items.length >= THUMBNAILS_FROM

const goTo = (model: Model, index: number): UpdateReturn => {
	const target = Math.min(model.items.length - 1, Math.max(0, index))
	return target === model.index ? { model } : { model, commands: [GoToSlide({ index: target })] }
}

/** Arrows turn the page at rest and move the view over a zoomed shot. */
const arrow = (model: Model, dx: number, dy: number): UpdateReturn =>
	model.isZoomed
		? { model, commands: [PanMedia({ dx: dx * KEY_PAN_PX, dy: dy * KEY_PAN_PX })] }
		: goTo(model, model.index + dx + dy)

const pressedKey = (model: Model, key: ViewerKey): UpdateReturn => {
	switch (key) {
		case "Escape":
			return close(model)
		case "ArrowLeft":
			return arrow(model, -1, 0)
		case "ArrowRight":
			return arrow(model, 1, 0)
		case "ArrowUp":
			return arrow(model, 0, -1)
		case "ArrowDown":
			return arrow(model, 0, 1)
		case "Home":
			return goTo(model, 0)
		case "End":
			return goTo(model, model.items.length - 1)
		case "+":
		case "=":
			return { model, commands: [StepZoom({ step: "in" })] }
		case "-":
		case "_":
			return { model, commands: [StepZoom({ step: "out" })] }
		case "0":
			return { model, commands: [StepZoom({ step: "reset" })] }
	}
}

const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		StartedTriggers: () => ({ model }),
		// A press while the viewer is open (a second click during a slow decode) is turned down.
		PressedTrigger: ({ items, index, plate, isReady }) =>
			model.isOpen
				? { model }
				: {
						model: { ...model, items, index, isOpen: true, isZoomed: false, canZoomIn: true },
						commands: [
							MarkTriggers({ plate, isReady }),
							ReportOpened({ label: items[index]?.alt ?? "" }),
							...decodeAround(items, index, model.decoded),
						],
					},
		// The strip opens on the pressed shot, wherever it sits in a long gallery.
		MountedViewer: () =>
			hasThumbnails(model)
				? { model, commands: [RevealThumbnail({ index: model.index, isInstant: true })] }
				: { model },
		// The track can still report a slide in the frames between a close and its render.
		ChangedSlide: ({ index }) =>
			!model.isOpen || index === model.index
				? { model }
				: {
						model: { ...model, index },
						commands: [
							MoveOrigin({ index }),
							...decodeAround(model.items, index, model.decoded),
							...(hasThumbnails(model) ? [RevealThumbnail({ index, isInstant: false })] : []),
						],
					},
		DecodedFull: ({ src }) =>
			model.decoded.includes(src)
				? { model }
				: { model: { ...model, decoded: [...model.decoded, src] } },
		ClickedThumbnail: ({ index }) => goTo(model, index),
		ChangedZoom: ({ isZoomed, canZoomIn }) => ({ model: { ...model, isZoomed, canZoomIn } }),
		PressedKey: ({ key }) => (model.isOpen ? pressedKey(model, key) : { model }),
		ClickedPrevious: () => goTo(model, model.index - 1),
		ClickedNext: () => goTo(model, model.index + 1),
		ClickedZoomIn: () => ({ model, commands: [StepZoom({ step: "in" })] }),
		ClickedZoomOut: () => ({ model, commands: [StepZoom({ step: "out" })] }),
		ClickedClose: () => close(model),
		Dismissed: () => close(model),
		// Reopened or closed again since: the marks belong to a later gallery or a later close.
		SettledClose: ({ closes }) =>
			!model.isOpen && closes === model.closes ? { model, commands: [ReleaseTriggers()] } : { model },
		CompletedSideEffect: () => ({ model }),
	})

// VIEW

const GLYPH = {
	close: "M6 6l12 12M18 6L6 18",
	previous: "M15 5l-7 7 7 7",
	next: "M9 5l7 7-7 7",
	zoomIn: "M12 5v14M5 12h14",
	zoomOut: "M5 12h14",
} as const

const glyph = (h: HtmlBuilder<Message>, d: string): Html =>
	h.svg(
		[
			h.ViewBox("0 0 24 24"),
			h.Width("18"),
			h.Height("18"),
			h.Fill("none"),
			h.Stroke("currentColor"),
			h.StrokeWidth("2"),
			h.StrokeLinecap("square"),
			h.AriaHidden(true),
		],
		[h.path([h.D(d)], [])],
	)

type Control = Readonly<{
	label: string
	d: string
	message: Message
	isDisabled?: boolean
	className?: string
	/** Out of the Tab order: a pointer's shortcut for something the keyboard already has. */
	isPointerOnly?: boolean
}>

/** A control at its limit stays focusable (`aria-disabled`), so the keyboard never loses its place. */
const control = (h: HtmlBuilder<Message>, options: Control): Html =>
	h.button(
		[
			h.Type("button"),
			h.Class(`lightbox__control ${options.className ?? ""}`),
			h.AriaLabel(options.label),
			...(options.isDisabled === true ? [h.AriaDisabled(true), h.DataAttribute("disabled", "")] : []),
			...(options.isPointerOnly === true ? [h.Tabindex(-1)] : []),
			h.OnClick(options.message),
		],
		[glyph(h, options.d)],
	)

const media = (h: HtmlBuilder<Message>, model: Model, item: Item, isActive: boolean): Html => {
	const shared = [
		h.DataAttribute("lightbox-media", ""),
		h.Class("lightbox__media"),
		h.Draggable(false),
		...(isActive ? [h.DataAttribute("active", "")] : []),
	]
	if (item.kind === "video") {
		// The plate's loop, larger: muted and inline like the page's, playing only while on show.
		return h.video(
			[
				...shared,
				h.Src(item.src),
				...(item.preview === "" ? [] : [h.Poster(item.preview)]),
				h.AriaLabel(item.alt),
				h.Muted(true),
				h.Loop(true),
				h.Playsinline(true),
				h.Autoplay(isActive),
			],
			[],
		)
	}
	const isFull = item.preview === "" || model.decoded.includes(item.src)
	// A narrower copy declared at the full file's width lays out at the full file's size, so the
	// swap changes only the sharpness, never the box the morph landed in.
	const atFullSize =
		!isFull && item.width > 0 && item.previewWidth > 0
			? [h.Srcset(`${item.preview} ${item.previewWidth}w`), h.Sizes(`${item.width}px`)]
			: []
	return h.img([
		...shared,
		h.Src(isFull ? item.src : item.preview),
		...atFullSize,
		h.Alt(item.alt),
		// The opening frame is a snapshot: the bitmap has to be in it.
		h.Decoding("sync"),
	])
}

const slide = (h: HtmlBuilder<Message>, model: Model, item: Item, index: number): Html => {
	const isActive = index === model.index
	return h.div(
		[
			h.DataAttribute("lightbox-slide", ""),
			h.Class("lightbox__slide"),
			h.Role("group"),
			h.AriaRoleDescription("slide"),
			h.AriaLabel(`${index + 1} of ${model.items.length}`),
			...(isActive ? [h.DataAttribute("active", "")] : [h.AriaHidden(true)]),
		],
		Math.abs(index - model.index) > PRELOAD
			? []
			: [
					h.div(
						[h.DataAttribute("lightbox-zoom", ""), h.Class("lightbox__zoom")],
						[media(h, model, item, isActive)],
					),
				],
	)
}

/**
 * A long gallery's strip of thumbnails, drawn from what the plates already loaded. The counter and
 * arrow keys already say where you are; this is a pointer's shortcut, out of the Tab order like the steps.
 */
const thumbnails = (h: HtmlBuilder<Message>, model: Model): Html =>
	h.div(
		[h.DataAttribute("lightbox-thumbnails", ""), h.Class("lightbox__thumbnails lightbox__chrome")],
		Arr.map(model.items, (item, index) =>
			h.button(
				[
					h.Type("button"),
					h.Class("lightbox__thumbnail"),
					h.DataAttribute("lightbox-thumbnail", String(index)),
					h.AriaLabel(`Show screenshot ${index + 1}: ${item.alt}`),
					h.Tabindex(-1),
					...(index === model.index ? [h.AriaCurrent("true"), h.DataAttribute("active", "")] : []),
					h.OnClick(Message.ClickedThumbnail({ index })),
				],
				item.preview === ""
					? []
					: [h.img([h.Src(item.preview), h.Alt(""), h.Draggable(false), h.Loading("lazy")])],
			),
		),
	)

/** What a screen reader hears on each slide: the shot's description, not just its number. */
const announcement = (model: Model, item: Item | undefined): string => {
	if (item === undefined) return ""
	const position = model.items.length > 1 ? `${model.index + 1} of ${model.items.length}. ` : ""
	return `${position}${item.alt}${item.caption === "" ? "" : `. ${item.caption}`}`
}

const viewer = (h: HtmlBuilder<Message>, model: Model): Html => {
	const count = model.items.length
	const isGallery = count > 1
	const item = model.items[model.index]
	const caption = item?.caption ?? ""
	return h.div(
		[h.Class("lightbox"), h.OnMount(MountViewer())],
		[
			h.div([h.Class("lightbox__backdrop"), h.AriaHidden(true)], []),
			focusGuard(h, "outside"),
			h.div(
				[
					h.DataAttribute("lightbox-content", ""),
					h.Class("lightbox__content"),
					h.Role("dialog"),
					h.AriaModal(true),
					h.AriaLabel(isGallery ? "Screenshot gallery" : "Enlarged screenshot"),
					h.Tabindex(-1),
					// Page-level shortcuts stand down for an open dialog (`isDialogOpen`).
					h.DataAttribute("open", ""),
					...(model.isZoomed ? [h.DataAttribute("zoomed", "")] : []),
					...(isGallery ? [h.DataAttribute("gallery", "")] : []),
					// Room for a caption is kept across the whole gallery, so shots do not resize between slides.
					...(Arr.some(model.items, (each) => each.caption !== "")
						? [h.DataAttribute("captioned", "")]
						: []),
					...(hasThumbnails(model) ? [h.DataAttribute("thumbnails", "")] : []),
				],
				[
					h.div(
						[
							h.DataAttribute("lightbox-slides", ""),
							h.Class("lightbox__slides"),
							h.Role("group"),
							h.AriaRoleDescription("carousel"),
							h.AriaLabel("Screenshots"),
						],
						Arr.map(model.items, (each, index) => slide(h, model, each, index)),
					),
					h.div(
						[h.AriaLive("polite"), h.AriaAtomic(true), h.Style(SR_ONLY_STYLE)],
						[announcement(model, item)],
					),
					h.div(
						[h.Class("lightbox__bar lightbox__chrome")],
						[
							h.div(
								[
									h.DataAttribute("lightbox-counter", ""),
									h.Class("lightbox__counter"),
									h.AriaHidden(true),
								],
								isGallery ? [`${model.index + 1} / ${count}`] : [],
							),
							h.div(
								[h.Class("lightbox__controls")],
								[
									control(h, {
										label: "Zoom out",
										d: GLYPH.zoomOut,
										message: Message.ClickedZoomOut(),
										isDisabled: !model.isZoomed,
									}),
									control(h, {
										label: "Zoom in",
										d: GLYPH.zoomIn,
										message: Message.ClickedZoomIn(),
										isDisabled: !model.canZoomIn,
									}),
									control(h, {
										label: "Close",
										d: GLYPH.close,
										message: Message.ClickedClose(),
									}),
								],
							),
						],
					),
					// Hidden on touch and while zoomed, so they stay out of the Tab order: arrows turn the page.
					...(isGallery
						? [
								control(h, {
									label: "Previous screenshot",
									d: GLYPH.previous,
									message: Message.ClickedPrevious(),
									isDisabled: model.index === 0,
									isPointerOnly: true,
									className: "lightbox__step lightbox__step--previous lightbox__chrome",
								}),
								control(h, {
									label: "Next screenshot",
									d: GLYPH.next,
									message: Message.ClickedNext(),
									isDisabled: model.index === count - 1,
									isPointerOnly: true,
									className: "lightbox__step lightbox__step--next lightbox__chrome",
								}),
							]
						: []),
					h.p(
						[
							h.DataAttribute("lightbox-caption", ""),
							h.Class("lightbox__caption lightbox__chrome"),
							h.AriaHidden(true),
						],
						caption === "" ? [] : [caption],
					),
					...(hasThumbnails(model) ? [thumbnails(h, model)] : []),
				],
			),
			focusGuard(h, "outside"),
		],
	)
}

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div([h.Class("contents"), h.OnMount(ListenForTriggers())], model.isOpen ? [viewer(h, model)] : [])

export const Lightbox = makeIsland({
	name: "Lightbox",
	Props: Schema.Struct({}),
	Model,
	init: () => ({
		model: {
			items: [],
			isOpen: false,
			index: 0,
			isZoomed: false,
			canZoomIn: true,
			decoded: [],
			closes: 0,
		},
	}),
	update,
	view,
	// Opening and closing are the two renders the browser animates between.
	viewTransition: ({ previousModel, model }) => previousModel.isOpen !== model.isOpen,
})
