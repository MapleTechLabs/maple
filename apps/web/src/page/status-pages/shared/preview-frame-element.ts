import { Option, Schema } from "effect"
import { CustomElement } from "foldkit"

// `<maple-preview-frame>`: the status page preview, double-buffered. A new `srcdoc` on an iframe
// reloads it, and for a frame or two the browser can paint it empty (the dashboard's background
// shows through, a black flash in dark mode). Here every new document loads in a second frame
// under the shown one, which is only removed once the new one has loaded and painted, so an edit
// never shows an empty frame.

export const PREVIEW_FRAME_TAG = "maple-preview-frame"

/** The message `KEEP_SCROLL_SCRIPT` posts on scroll, so the next frame opens where this one was. */
export const SCROLL_MESSAGE = "maple-preview-scroll"

/** Read by `KEEP_SCROLL_SCRIPT`: the frame's `window.name` carries the scroll it opens at. */
export const SCROLL_NAME_PREFIX = "maple-preview-scroll:"

/** Attributes copied onto both frames. `frame-id` and `frame-title` become the shown frame's `id` and `title`. */
const FORWARDED = ["sandbox", "allow"] as const

const decodeScroll = Schema.decodeUnknownOption(
	Schema.Struct({ type: Schema.Literal(SCROLL_MESSAGE), y: Schema.Number }),
)

const FRAME_STYLE =
	"position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:transparent"

const define = (): void => {
	class PreviewFrameElement extends HTMLElement {
		static observedAttributes = ["srcdoc", "frame-id", "frame-title", ...FORWARDED]
		private shown: HTMLIFrameElement | null = null
		private loading: HTMLIFrameElement | null = null
		private scrollY = 0
		private readonly onMessage = (event: MessageEvent) => {
			if (this.shown === null || event.source !== this.shown.contentWindow) return
			const scroll = decodeScroll(event.data)
			if (Option.isSome(scroll)) this.scrollY = scroll.value.y
		}

		connectedCallback(): void {
			window.addEventListener("message", this.onMessage)
			if (this.shown === null) this.load()
		}

		disconnectedCallback(): void {
			window.removeEventListener("message", this.onMessage)
		}

		attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
			if (previous === next || !this.isConnected) return
			if (name === "srcdoc") {
				this.load()
				return
			}
			if (name === "frame-id" || name === "frame-title") {
				if (this.shown !== null) this.label(this.shown)
				return
			}
			for (const frame of [this.shown, this.loading])
				if (frame !== null) {
					if (next === null) frame.removeAttribute(name)
					else frame.setAttribute(name, next)
				}
		}

		private label(frame: HTMLIFrameElement): void {
			const id = this.getAttribute("frame-id")
			if (id === null) frame.removeAttribute("id")
			else frame.id = id
			frame.title = this.getAttribute("frame-title") ?? ""
		}

		private create(): HTMLIFrameElement {
			const frame = document.createElement("iframe")
			frame.setAttribute("style", FRAME_STYLE)
			for (const name of FORWARDED) {
				const value = this.getAttribute(name)
				if (value !== null) frame.setAttribute(name, value)
			}
			// The browsing context takes its `window.name` from this as the frame is inserted.
			frame.name = `${SCROLL_NAME_PREFIX}${Math.round(this.scrollY)}`
			return frame
		}

		/** The first document shows at once; later ones load under it and swap in once painted. */
		private load(): void {
			const srcdoc = this.getAttribute("srcdoc") ?? ""
			if (this.shown === null) {
				const frame = this.create()
				this.label(frame)
				this.append(frame)
				frame.srcdoc = srcdoc
				this.shown = frame
				return
			}
			// A newer document replaces one still loading; the shown frame stays until it lands.
			this.loading?.remove()
			const frame = this.create()
			frame.style.zIndex = "0"
			frame.setAttribute("aria-hidden", "true")
			frame.tabIndex = -1
			this.shown.style.zIndex = "1"
			this.prepend(frame)
			this.loading = frame
			frame.addEventListener(
				"load",
				() =>
					// Two frames: the first lets the loaded document paint under the shown one.
					requestAnimationFrame(() =>
						requestAnimationFrame(() => {
							if (this.loading !== frame) return
							const previous = this.shown
							frame.removeAttribute("aria-hidden")
							frame.removeAttribute("tabindex")
							frame.style.zIndex = ""
							previous?.removeAttribute("id")
							this.label(frame)
							this.shown = frame
							this.loading = null
							previous?.remove()
						}),
					),
				{ once: true },
			)
			frame.srcdoc = srcdoc
		}
	}
	customElements.define(PREVIEW_FRAME_TAG, PreviewFrameElement)
}

// Scene tests render in node, where there is nothing to register.
if (typeof customElements !== "undefined" && customElements.get(PREVIEW_FRAME_TAG) === undefined) define()

/** The typed tag for views; attributes go through `h.Srcdoc`, `h.Sandbox`, `h.Attribute`. */
export const previewFrameElement = CustomElement.define({
	tag: PREVIEW_FRAME_TAG,
	properties: {},
	events: {},
})
