import { type ChartSpec, decodeChartSpec } from "@maple/views/charts/chart-spec"
import { Option } from "effect"
import { assert, describe, expect, it, vi } from "vitest"
import start from "../../foldkit-island/client"
import type { Island } from "../../foldkit-island/island"
import renderer from "../../foldkit-island/server"
import { LiveErrors } from "./LiveErrors"
import { LiveMetrics } from "./LiveMetrics"
import { LiveWebAnalytics } from "./LiveWebAnalytics"

const chartSpec = (element: HTMLElement) =>
	element.querySelector("[data-chart-spec]")?.getAttribute("data-chart-spec")

/** Serves the island, checks what the server drew, starts it, and hands back the spec the chart was given. */
const drawn = async (island: Island, served: string): Promise<ChartSpec> => {
	const element = document.body.appendChild(document.createElement("astro-island"))
	const { html } = await renderer.renderToStaticMarkup(island, {})
	element.innerHTML = html
	expect(element.textContent).toContain("DEMO")
	expect(element.textContent).toContain(served)
	// Before the browser runs it, the plot box holds a plain drawing and no chart.
	expect(element.querySelector("[aria-hidden=true]")).not.toBeNull()
	expect(chartSpec(element)).toBeUndefined()

	await start(element)(island, {})
	await vi.waitFor(() => expect(chartSpec(element)).toBeDefined())
	const spec = decodeChartSpec(chartSpec(element))
	assert(Option.isSome(spec))

	element.dispatchEvent(new Event("astro:unmount"))
	await vi.waitFor(() => expect(element.textContent).toBe(""))
	return spec.value
}

describe("the bento's chart islands", () => {
	it("LiveMetrics draws three percentile lines whose newest minute is still filling", async () => {
		const spec = await drawn(LiveMetrics, "p95")
		assert(spec._tag === "QueryBuilderArea")
		expect(spec.mark).toBe("line")
		expect(spec.unit).toBe("duration_ms")
		expect(spec.data).toHaveLength(36)
		expect(spec.data[0]).toHaveProperty("p50")
		expect(spec.data[0]).toHaveProperty("p99")
		const newestStart = Date.parse(String(spec.data.at(-1)?.["bucket"]))
		expect(spec.nowMs).toBeGreaterThan(newestStart)
		expect(spec.nowMs).toBeLessThan(newestStart + 60_000)
	})

	it("LiveErrors opens on the headline's 142 events in one issue, over a day of hourly counts", async () => {
		const spec = await drawn(LiveErrors, "142")
		assert(spec._tag === "Occurrences")
		expect(spec.points).toHaveLength(24)
		expect(spec.timeZone).toBe("UTC")
	})

	it("LiveWebAnalytics pairs visitors with page views over a week", async () => {
		const spec = await drawn(LiveWebAnalytics, "Unique visitors")
		assert(spec._tag === "AnalyticsTraffic")
		expect(spec.points).toHaveLength(84)
		expect(spec.series).toEqual([
			{ key: "companion", metric: "pageViews" },
			{ key: "primary", metric: "visitors" },
		])
	})
})
