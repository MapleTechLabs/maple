// @vitest-environment happy-dom
import { assert, describe, expect, it, vi } from "vitest"
import { tokenFallback } from "@maple/ui/lib/colors"
import start from "../../foldkit-island/client"
import renderer from "../../foldkit-island/server"
import { LiveLogsVolumeChart } from "./LiveLogsVolumeChart"

const chartSpec = (element: HTMLElement) => element.querySelector("[data-chart-spec]")?.getAttribute("data-chart-spec")

describe("LiveLogsVolumeChart island", () => {
	it("serves a static preview, then draws the stub buckets in literal severity colours before the stylesheet applies", async () => {
		const element = document.body.appendChild(document.createElement("astro-island"))
		const { html } = await renderer.renderToStaticMarkup(LiveLogsVolumeChart, {})
		element.innerHTML = html
		expect(element.textContent).toContain("14.0K logs")
		expect(chartSpec(element)).toBeUndefined()
		// The static preview: one stacked column per stub bucket, in the severity tokens.
		const columns = element.querySelectorAll(".w-full > [aria-hidden=true] > div")
		expect(columns).toHaveLength(60)
		expect(columns[0]?.firstElementChild?.getAttribute("style")).toContain("var(--severity-debug)")

		await start(element)(LiveLogsVolumeChart, {})
		await vi.waitFor(() => expect(chartSpec(element)).toBeDefined())
		const encoded = chartSpec(element)
		assert(encoded !== null && encoded !== undefined)
		const spec: unknown = JSON.parse(encoded)
		expect(spec).toMatchObject({
			_tag: "LogsVolume",
			seriesKeys: ["DEBUG", "INFO", "WARN", "ERROR"],
			colors: {
				DEBUG: tokenFallback("--severity-debug"),
				INFO: tokenFallback("--severity-info"),
				WARN: tokenFallback("--severity-warn"),
				ERROR: tokenFallback("--severity-error"),
			},
		})
		expect(spec).toHaveProperty("buckets.length", 60)

		element.dispatchEvent(new Event("astro:unmount"))
		await vi.waitFor(() => expect(element.textContent).toBe(""))
	})
})
