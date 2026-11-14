// @vitest-environment happy-dom
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { afterEach, assert, describe, expect, it, vi } from "vitest"
import { PricingCalculator } from "../components/PricingCalculator"
import { defaultValues, estimateVendor, formatCurrency } from "../lib/vendor-pricing"
import start from "./client"
import { makeIsland } from "./island"
import renderer from "./server"

const props = { competitor: "datadog", compact: true }
const datadogTotal = (element: HTMLElement) => element.querySelectorAll("dd")[1]?.textContent

const Flipped = defineMessageUnion({ Flipped: {} })

/** Flips between two labels, and asks for a View Transition on the flip to "on" only. */
const Switch = makeIsland({
	name: "Switch",
	Props: Schema.Struct({}),
	Model: Schema.Struct({ isOn: Schema.Boolean }),
	init: () => ({ model: { isOn: false } }),
	update: (model) => ({ model: { isOn: !model.isOn } }),
	view: (model, h) => h.button([h.OnClick(Flipped.Flipped())], [model.isOn ? "on" : "off"]),
	viewTransition: ({ model }) => model.isOn,
})

afterEach(() => {
	Reflect.deleteProperty(document, "startViewTransition")
})

describe("island client entry", () => {
	it("renders inside a View Transition when the island asks for one", async () => {
		// The browser's side of the API: run the render, report it done.
		const startViewTransition = vi.fn((render: () => void) => {
			render()
			return {
				updateCallbackDone: Promise.resolve(),
				ready: Promise.resolve(),
				finished: Promise.resolve(),
				skipTransition: () => {},
			}
		})
		Object.defineProperty(document, "startViewTransition", {
			configurable: true,
			value: startViewTransition,
		})
		const element = document.body.appendChild(document.createElement("astro-island"))
		element.innerHTML = (await renderer.renderToStaticMarkup(Switch, {})).html
		await start(element)(Switch, {})
		await vi.waitFor(() => expect(element.querySelector("button")?.textContent).toBe("off"))

		element.querySelector("button")?.click()
		await vi.waitFor(() => expect(element.querySelector("button")?.textContent).toBe("on"))
		expect(startViewTransition).toHaveBeenCalledTimes(1)
		// The flip back is a plain render: the island's predicate said no.
		element.querySelector("button")?.click()
		await vi.waitFor(() => expect(element.querySelector("button")?.textContent).toBe("off"))
		expect(startViewTransition).toHaveBeenCalledTimes(1)
		element.dispatchEvent(new Event("astro:unmount"))
	})

	it("takes over the server markup, reprices on input and tears down on unmount", async () => {
		const element = document.body.appendChild(document.createElement("astro-island"))
		element.innerHTML = (await renderer.renderToStaticMarkup(PricingCalculator, props)).html
		const serverRoot = element.firstElementChild
		await start(element)(PricingCalculator, props)
		await vi.waitFor(() => expect(element.firstElementChild).not.toBe(serverRoot))
		expect(datadogTotal(element)).toBe(
			`${formatCurrency(estimateVendor("datadog", defaultValues("datadog")).total)}/mo`,
		)

		const values = { ...defaultValues("datadog"), hosts: 200 }
		const hosts = element.querySelector<HTMLInputElement>("input[type=range]")
		assert(hosts !== null)
		hosts.value = "200"
		hosts.dispatchEvent(new Event("input", { bubbles: true }))
		const repriced = `${formatCurrency(estimateVendor("datadog", values).total)}/mo`
		await vi.waitFor(() => expect(datadogTotal(element)).toBe(repriced))

		// Disposing tears the live tree down and gives the container back empty.
		element.dispatchEvent(new Event("astro:unmount"))
		await vi.waitFor(() => expect(hosts.isConnected).toBe(false))
		expect(element.textContent).toBe("")
	})
})
