// @vitest-environment happy-dom
import { assert, describe, expect, it, vi } from "vitest"
import { PricingCalculator } from "../components/PricingCalculator"
import { defaultValues, estimateVendor, formatCurrency } from "../lib/vendor-pricing"
import start from "./client"
import renderer from "./server"

const props = { competitor: "datadog", compact: true }
const datadogTotal = (element: HTMLElement) => element.querySelectorAll("dd")[1]?.textContent

describe("island client entry", () => {
	it("takes over the server markup, reprices on input and tears down on unmount", async () => {
		const element = document.body.appendChild(document.createElement("astro-island"))
		element.innerHTML = (await renderer.renderToStaticMarkup(PricingCalculator, props)).html
		const serverRoot = element.firstElementChild
		await start(element)(PricingCalculator, props)
		await vi.waitFor(() => expect(element.firstElementChild).not.toBe(serverRoot))
		expect(datadogTotal(element)).toBe(`${formatCurrency(estimateVendor("datadog", defaultValues("datadog")).total)}/mo`)

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
