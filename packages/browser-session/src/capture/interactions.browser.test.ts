import { afterEach, describe, expect, it } from "vitest"
import type { SessionEvent } from "../events/events-sink"
import { installInteractionCapture } from "./interactions"

const SECRET = "4111-1111-1111-1111"

let stop: (() => void) | undefined
let host: HTMLElement | undefined

afterEach(() => {
	stop?.()
	stop = undefined
	host?.remove()
	host = undefined
})

/** Click the first element matching `selector` inside `html` and return the captured text. */
function clickText(html: string, selector: string, maskAllText = false): string | undefined {
	const events: SessionEvent[] = []
	stop = installInteractionCapture((ev) => events.push(ev), maskAllText)
	host = document.createElement("div")
	host.innerHTML = html
	document.body.appendChild(host)
	const target = host.querySelector(selector)
	if (!(target instanceof HTMLElement)) throw new Error(`no ${selector} in fixture`)
	target.click()
	expect(events).toHaveLength(1)
	return events[0]?.targetText
}

describe("click target text", () => {
	it.each([
		["a data-rr-block descendant", `<button>Pay <span data-rr-block>${SECRET}</span> now</button>`],
		["an .rr-block descendant", `<button>Pay <span class="rr-block">${SECRET}</span> now</button>`],
		["an .rr-mask descendant", `<button>Pay <span class="rr-mask">${SECRET}</span> now</button>`],
		["a script", `<button>Pay <script type="text/plain">${SECRET}</script> now</button>`],
		["a style", `<button>Pay <style>.x::after { content: "${SECRET}" }</style> now</button>`],
		["a template", `<button>Pay <template>${SECRET}</template> now</button>`],
		[
			"a contenteditable region",
			`<button>Pay <span contenteditable="true">${SECRET}</span> now</button>`,
		],
		["a textarea default value", `<button>Pay <textarea>${SECRET}</textarea> now</button>`],
		["a select's options", `<button>Pay <select><option>${SECRET}</option></select> now</button>`],
	])("never includes text inside %s", (_, html) => {
		const text = clickText(html, "button")
		expect(text).toBe("Pay now")
	})

	it("omits the text of a click inside a masked subtree", () => {
		expect(clickText(`<div class="rr-mask"><button>${SECRET}</button></div>`, "button")).toBeUndefined()
	})

	it("omits the text of a click on a contenteditable element", () => {
		expect(clickText(`<div contenteditable="true"><p>${SECRET}</p></div>`, "p")).toBeUndefined()
	})

	it("omits all text under maskAllText", () => {
		expect(clickText(`<button>${SECRET}</button>`, "button", true)).toBeUndefined()
	})

	it("collapses whitespace across nested elements", () => {
		expect(clickText("<button>\n  <b>Save</b>\n  <i>changes</i>\n</button>", "button")).toBe(
			"Save changes",
		)
	})

	it("caps a large subtree's text without splitting an emoji", () => {
		// 119 ASCII units then an emoji straddling the 120-unit cap.
		const text = clickText(
			`<div id="big">${"a".repeat(119)}😀${"<p>more</p>".repeat(2000)}</div>`,
			"#big",
		)
		expect(text).toBe(`${"a".repeat(119)}…`)
	})
})
