// @vitest-environment happy-dom
import { Array as Arr } from "effect"
import { afterEach, assert, describe, expect, it, vi } from "vitest"
import start from "../../foldkit-island/client"
import renderer from "../../foldkit-island/server"
import { Lightbox } from "./Lightbox"

// An article with three shots (one captioned), a linked image and a decorative avatar, neither
// of them enlargeable, and outside it a marketing plate with a full-size source of its own.
const PAGE = `
	<article class="docs-content">
		<img id="avatar" src="/people/author.webp" alt="">
		<figure class="shot">
			<img id="first" src="/shots/first.webp" alt="First shot">
			<figcaption> The first caption. </figcaption>
		</figure>
		<a href="/elsewhere"><img id="linked" src="/shots/linked.webp" alt="Linked shot"></a>
		<figure class="shot"><img id="second" src="/shots/second.webp" alt="Second shot"></figure>
		<img id="third" src="/shots/third.webp" alt="Third shot">
	</article>
	<figure>
		<figcaption>dashboard / overview</figcaption>
		<img id="hero" data-zoomable data-zoom-src="/shots/hero@2x.webp" src="/shots/hero.webp" alt="Hero shot">
	</figure>
`

const mounted: Array<HTMLElement> = []

const mount = async () => {
	document.body.innerHTML = PAGE
	const element = document.body.appendChild(document.createElement("astro-island"))
	element.innerHTML = (await renderer.renderToStaticMarkup(Lightbox, {})).html
	mounted.push(element)
	await start(element)(Lightbox, {})
	// The island marks the plates once it is listening.
	await vi.waitFor(() => expect(plate("first").getAttribute("aria-haspopup")).toBe("dialog"))
	return element
}

const plate = (id: string): HTMLElement => {
	const element = document.getElementById(id)
	assert(element instanceof HTMLElement)
	return element
}

const dialogs = () => document.querySelectorAll('[role="dialog"]')
const dialog = () => dialogs().item(0)
const counter = () => document.querySelector("[data-lightbox-counter]")?.textContent ?? ""
const caption = () => document.querySelector("[data-lightbox-caption]")?.textContent ?? ""
const announced = () => document.querySelector('[role="dialog"] [aria-live]')?.textContent ?? ""
/** The slides that have their bitmap mounted, by path: a plate's `src` reads back resolved. */
const shown = () =>
	Arr.map(
		[...document.querySelectorAll("img[data-lightbox-media]")],
		(image) => new URL(image.getAttribute("src") ?? "", window.location.href).pathname,
	)
const marked = (attribute: string) =>
	Arr.map([...document.querySelectorAll(`[${attribute}]`)], (element) => element.id)
const press = (key: string, init: KeyboardEventInit = {}) =>
	document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }))
const button = (label: string): HTMLElement => {
	const element = document.querySelector(`button[aria-label="${label}"]`)
	assert(element instanceof HTMLElement)
	return element
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** A full-size bitmap that never finishes decoding: the viewer has to open without it. */
const stallDecodes = () =>
	vi.spyOn(HTMLImageElement.prototype, "decode").mockReturnValue(new Promise<void>(() => {}))

afterEach(() => {
	Arr.forEach(mounted.splice(0), (element) => element.dispatchEvent(new Event("astro:unmount")))
	vi.restoreAllMocks()
	document.body.innerHTML = ""
})

describe("Lightbox island", () => {
	it("renders nothing until a plate is pressed", async () => {
		const markup = (await renderer.renderToStaticMarkup(Lightbox, {})).html
		expect(markup).not.toContain("dialog")
		await mount()
		expect(dialogs()).toHaveLength(0)
	})

	it("makes each enlargeable shot a labelled button, and leaves links and decoration alone", async () => {
		await mount()
		expect(plate("second").tabIndex).toBe(0)
		expect(plate("second").getAttribute("role")).toBe("button")
		expect(plate("second").getAttribute("aria-label")).toBe("Enlarge screenshot: Second shot")
		expect(plate("linked").hasAttribute("data-zoomable")).toBe(false)
		expect(plate("avatar").hasAttribute("data-zoomable")).toBe(false)
		expect(plate("avatar").hasAttribute("role")).toBe(false)
	})

	it("opens an article's shots as one gallery, on the one that was clicked", async () => {
		await mount()
		plate("second").click()
		await vi.waitFor(() => expect(counter()).toBe("2 / 3"))
		// The open slide and its neighbours have their bitmaps; the link and the avatar are not slides.
		expect(shown()).toEqual(["/shots/first.webp", "/shots/second.webp", "/shots/third.webp"])
		expect(document.querySelector("[data-lightbox-media][data-active]")?.getAttribute("alt")).toBe(
			"Second shot",
		)
		expect(dialog()?.getAttribute("aria-label")).toBe("Screenshot gallery")
		expect(dialog()?.contains(document.activeElement)).toBe(true)
		expect(announced()).toBe("2 of 3. Second shot")
		await vi.waitFor(() => expect(marked("data-lightbox-trigger")).toEqual(["first", "second", "third"]))
		expect(marked("data-lightbox-origin")).toEqual(["second"])
	})

	it("turns pages with the keyboard and the step buttons, and stops at the ends", async () => {
		await mount()
		plate("first").click()
		await vi.waitFor(() => expect(counter()).toBe("1 / 3"))
		expect(caption()).toBe("The first caption.")
		expect(announced()).toBe("1 of 3. First shot. The first caption.")
		expect(button("Previous screenshot").getAttribute("aria-disabled")).toBe("true")

		press("ArrowRight")
		await vi.waitFor(() => expect(counter()).toBe("2 / 3"))
		expect(caption()).toBe("")
		button("Next screenshot").click()
		await vi.waitFor(() => expect(counter()).toBe("3 / 3"))
		press("ArrowRight")
		press("Home")
		await vi.waitFor(() => expect(counter()).toBe("1 / 3"))
		press("End")
		await vi.waitFor(() => expect(counter()).toBe("3 / 3"))
		button("Previous screenshot").click()
		await vi.waitFor(() => expect(counter()).toBe("2 / 3"))
	})

	it("leaves a modified key to the browser", async () => {
		await mount()
		plate("first").click()
		await vi.waitFor(() => expect(counter()).toBe("1 / 3"))
		const zoomPage = new KeyboardEvent("keydown", {
			key: "+",
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		})
		document.dispatchEvent(zoomPage)
		expect(zoomPage.defaultPrevented).toBe(false)
		const turnPage = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })
		document.dispatchEvent(turnPage)
		expect(turnPage.defaultPrevented).toBe(true)
	})

	it("closes on Escape, into the plate of the slide that was open", async () => {
		await mount()
		plate("first").click()
		await vi.waitFor(() => expect(counter()).toBe("1 / 3"))
		await vi.waitFor(() => expect(document.querySelector("body > [aria-hidden='true']")).not.toBeNull())
		press("End")
		await vi.waitFor(() => expect(marked("data-lightbox-origin")).toEqual(["third"]))

		press("Escape")
		await vi.waitFor(() => expect(dialogs()).toHaveLength(0))
		expect(document.activeElement).toBe(plate("third"))
		expect(document.querySelector("body > [aria-hidden='true']")).toBeNull()
		expect(document.body.style.overflow).toBe("")
	})

	it("pulls focus back when it lands on the page behind", async () => {
		await mount()
		plate("first").click()
		await vi.waitFor(() => expect(dialog()?.contains(document.activeElement)).toBe(true))
		plate("second").focus()
		expect(dialog()?.contains(document.activeElement)).toBe(true)
	})

	it("closes from its Close button and can be opened again", async () => {
		await mount()
		plate("third").click()
		await vi.waitFor(() => expect(counter()).toBe("3 / 3"))
		button("Close").click()
		await vi.waitFor(() => expect(dialogs()).toHaveLength(0))
		plate("first").click()
		await vi.waitFor(() => expect(counter()).toBe("1 / 3"))
	})

	it("opens a plate outside an article alone, from its full-size source", async () => {
		await mount()
		plate("hero").click()
		await vi.waitFor(() => expect(dialog()?.getAttribute("aria-label")).toBe("Enlarged screenshot"))
		expect(shown()).toEqual(["/shots/hero@2x.webp"])
		expect(counter()).toBe("")
		expect(announced()).toBe("Hero shot")
		expect(document.querySelector('button[aria-label="Next screenshot"]')).toBeNull()
		// A frame's heading above the shot is not its caption.
		expect(caption()).toBe("")
	})

	it("opens without the morph when the bitmap is not ready, and still returns focus", async () => {
		await mount()
		stallDecodes()
		plate("hero").focus()
		plate("hero").click()
		await vi.waitFor(() => expect(dialogs()).toHaveLength(1))
		await vi.waitFor(() => expect(marked("data-lightbox-trigger")).toEqual(["hero"]))
		expect(marked("data-lightbox-origin")).toEqual([])
		press("Escape")
		await vi.waitFor(() => expect(dialogs()).toHaveLength(0))
		expect(document.activeElement).toBe(plate("hero"))
	})

	it("turns down a second press made while the first is still opening", async () => {
		await mount()
		stallDecodes()
		plate("hero").click()
		plate("first").click()
		await vi.waitFor(() => expect(dialog()?.getAttribute("aria-label")).toBe("Enlarged screenshot"))
		await pause(300)
		// The second press neither opened nor left its marks on the article's plates.
		expect(dialogs()).toHaveLength(1)
		expect(marked("data-lightbox-trigger")).toEqual(["hero"])
	})

	it("keeps a reopened gallery's marks when an earlier close's clean-up comes due", async () => {
		await mount()
		plate("first").click()
		await vi.waitFor(() => expect(counter()).toBe("1 / 3"))
		press("Escape")
		await vi.waitFor(() => expect(dialogs()).toHaveLength(0))
		await pause(350)
		plate("second").click()
		await vi.waitFor(() => expect(counter()).toBe("2 / 3"))
		// The first close's clean-up was due 600 ms after it: by now it has come and gone.
		await pause(450)
		expect(marked("data-lightbox-origin")).toEqual(["second"])
		press("Escape")
		await vi.waitFor(() => expect(dialogs()).toHaveLength(0))
		await vi.waitFor(() => expect(marked("data-lightbox-trigger")).toEqual([]), { timeout: 2000 })
	})

	it("opens from the keyboard on a focused plate", async () => {
		await mount()
		plate("second").dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
		)
		await vi.waitFor(() => expect(counter()).toBe("2 / 3"))
	})

	it("ignores a key still held down from closing", async () => {
		await mount()
		plate("second").dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true }),
		)
		await pause(300)
		expect(dialogs()).toHaveLength(0)
	})

	it("keeps its keys from the page behind", async () => {
		await mount()
		const behind = vi.fn()
		document.addEventListener("keydown", behind)
		plate("first").click()
		await vi.waitFor(() => expect(counter()).toBe("1 / 3"))
		press("Escape")
		await vi.waitFor(() => expect(dialogs()).toHaveLength(0))
		expect(behind).not.toHaveBeenCalled()
		// Closed, the viewer takes nothing: the page hears its keys again.
		press("Escape")
		expect(behind).toHaveBeenCalledTimes(1)
		document.removeEventListener("keydown", behind)
	})

	it("takes every listener it put on the document back off when the island unmounts", async () => {
		const added = vi.spyOn(document, "addEventListener")
		const removed = vi.spyOn(document, "removeEventListener")
		const element = await mount()
		plate("first").click()
		await vi.waitFor(() => expect(counter()).toBe("1 / 3"))
		// The same handler, not just the same event type: a leak keeps the original on the document.
		const pressListeners = Arr.filter(
			added.mock.calls,
			([type]) => type === "click" || type === "keydown",
		)
		expect(Arr.map(pressListeners, ([type]) => type)).toEqual(
			expect.arrayContaining(["click", "keydown", "keydown"]),
		)
		element.dispatchEvent(new Event("astro:unmount"))
		await vi.waitFor(() =>
			expect(Arr.map(removed.mock.calls, ([type, handler]) => [type, handler])).toEqual(
				expect.arrayContaining(Arr.map(pressListeners, ([type, handler]) => [type, handler])),
			),
		)
	})
})
