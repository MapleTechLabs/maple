import { decodeChartSpec } from "@maple/views/charts/chart-spec"
import { Option } from "effect"
import { assert, describe, expect, it, vi } from "vitest"
import start from "../../foldkit-island/client"
import renderer from "../../foldkit-island/server"
import { LiveCostBudgets } from "./LiveCostBudgets"
import { LiveCostExplorer } from "./LiveCostExplorer"
import { LiveCostStatement } from "./LiveCostStatement"
import { costView, DIMENSIONS, drillTarget, formatMoney } from "./live-cost-data"

const rowNames = (element: Element) =>
	[...element.querySelectorAll("tbody tr td:first-child")].map((cell) => cell.textContent)

const chartSpec = (element: Element) =>
	decodeChartSpec(element.querySelector("[data-chart-spec]")?.getAttribute("data-chart-spec") ?? null)

describe("LiveCostExplorer island", () => {
	it("serves the page by provider, then a row's click narrows to it and splits it by service", async () => {
		const element = document.body.appendChild(document.createElement("astro-island"))
		const { html } = await renderer.renderToStaticMarkup(LiveCostExplorer, {})
		element.innerHTML = html
		// The server's page: the figures and the breakdown, with the chart as a static preview.
		expect(element.querySelector("table")?.getAttribute("aria-label")).toBe("Cost by provider")
		expect(rowNames(element)[0]).toBe("AWS")
		expect(element.querySelector("[data-chart-spec]")).toBeNull()

		await start(element)(LiveCostExplorer, {})
		await vi.waitFor(() => expect(element.querySelector("[data-chart-spec]")).not.toBeNull())
		expect(Option.getOrThrow(chartSpec(element))).toMatchObject({
			_tag: "QueryBuilderBar",
			stacked: true,
			unit: "currency:USD",
		})

		// A legend entry hides its series in the plot. It is remembered by name: regrouped by
		// service nothing is hidden, and back by provider AWS is hidden again.
		const spec = () => Option.getOrThrow(chartSpec(element))
		const press = (selector: string) => element.querySelector<HTMLButtonElement>(selector)?.click()
		press("button[title='AWS']")
		await vi.waitFor(() => expect(spec()).toMatchObject({ hidden: ["s1"] }))
		press("[role=group] button[aria-label='Service']")
		await vi.waitFor(() =>
			expect(element.querySelector("table")?.getAttribute("aria-label")).toBe("Cost by service"),
		)
		expect(spec()).not.toHaveProperty("hidden")
		press("[role=group] button[aria-label='Provider']")
		await vi.waitFor(() => expect(spec()).toMatchObject({ hidden: ["s1"] }))
		press("button[title='AWS']")
		await vi.waitFor(() => expect(spec()).not.toHaveProperty("hidden"))

		const aws = element.querySelector<HTMLButtonElement>("tbody tr button")
		assert(aws !== null)
		aws.click()
		await vi.waitFor(() =>
			expect(element.querySelector("table")?.getAttribute("aria-label")).toBe("Cost by service"),
		)
		// Only AWS services are left, and the filter in effect is a removable chip.
		expect(rowNames(element)).toContain("Amazon Elastic Compute Cloud")
		expect(rowNames(element)).not.toContain("Workers")
		expect(element.querySelector("[aria-label='Remove filter: Provider is AWS']")).not.toBeNull()
		// The clicked row is gone: focus lands on the first of the new rows, not on the page.
		await vi.waitFor(() => expect(document.activeElement).toBe(element.querySelector("tbody tr button")))

		// Two more clicks reach the last level: one row, plain text. Focus goes to the grouping.
		const service = element.querySelector<HTMLButtonElement>("tbody tr button")
		assert(service !== null)
		service.click()
		await vi.waitFor(() =>
			expect(element.querySelector("table")?.getAttribute("aria-label")).toBe("Cost by region"),
		)
		const region = element.querySelector<HTMLButtonElement>("tbody tr button")
		assert(region !== null)
		region.click()
		await vi.waitFor(() => expect(element.querySelector("tbody tr button")).toBeNull())
		await vi.waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Region"))

		// Removing a chip takes its button away: focus goes to the grouping, not to the page.
		element.querySelector<HTMLButtonElement>("[aria-label^='Remove filter: Region']")?.click()
		await vi.waitFor(() =>
			expect(element.querySelector("[aria-label^='Remove filter: Region']")).toBeNull(),
		)
		await vi.waitFor(() => expect(document.activeElement?.getAttribute("aria-pressed")).toBe("true"))

		element.dispatchEvent(new Event("astro:unmount"))
		await vi.waitFor(() => expect(element.textContent).toBe(""))
	})
})

describe("LiveCostBudgets island", () => {
	it("draws a budget past its amount as full and critical", async () => {
		const element = document.createElement("div")
		element.innerHTML = (await renderer.renderToStaticMarkup(LiveCostBudgets, {})).html
		const row = [...element.querySelectorAll("tbody tr")].find((candidate) =>
			candidate.textContent?.includes("AI models"),
		)
		assert(row !== undefined)
		const meter = row.querySelector("[role=meter]")
		// A meter's value never passes its max; the label carries the real percent.
		expect(meter?.getAttribute("aria-valuenow")).toBe(meter?.getAttribute("aria-valuemax"))
		expect(meter?.getAttribute("aria-label")).toContain("106%")
		expect(row.textContent).toContain("Critical")
	})
})

describe("LiveCostStatement island", () => {
	it("lists every provider's bill, and the lines add up to the total it states", async () => {
		const element = document.createElement("div")
		element.innerHTML = (await renderer.renderToStaticMarkup(LiveCostStatement, {})).html
		const amounts = [...element.querySelectorAll("li")].map((item) =>
			Number((item.lastElementChild?.textContent ?? "").replace(/[$,]/gu, "")),
		)
		const explorer = costView("provider", [], "cost")
		expect(amounts).toHaveLength(explorer.rows.length)
		expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBeCloseTo(explorer.cost, 1)
		expect(element.textContent).toContain(formatMoney(explorer.cost))
	})
})

describe("cost fixture", () => {
	it.each(DIMENSIONS)("the %s rows add up to the window's cost", (dimension) => {
		const view = costView(dimension, [], "cost")
		const sum = view.rows.reduce((total, row) => total + row.cost, 0)
		expect(sum).toBeCloseTo(view.cost, 1)
		expect(view.cost).toBeCloseTo(costView("provider", [], "cost").cost, 1)
	})

	it("a filter narrows every read to its key", () => {
		const all = costView("cloud_service", [], "cost")
		const aws = costView("cloud_service", [{ dimension: "provider", value: "aws" }], "cost")
		expect(aws.cost).toBeLessThan(all.cost)
		expect(aws.rows.map((row) => row.key)).not.toContain("Workers")
	})

	it("orders by change when asked", () => {
		const changes = costView("provider", [], "change").rows.map((row) => row.cost - row.previousCost)
		expect(changes).toEqual([...changes].sort((a, b) => b - a))
	})

	it("drills to the next dimension no filter has narrowed", () => {
		expect(drillTarget("provider", [{ dimension: "provider", value: "aws" }])).toBe("cloud_service")
		expect(
			drillTarget("cloud_service", [
				{ dimension: "provider", value: "aws" },
				{ dimension: "cloud_service", value: "AWS Lambda" },
				{ dimension: "region", value: "us-east-1" },
			]),
		).toBe("cloud_service")
	})
})
