// @vitest-environment happy-dom
import { afterEach, assert, describe, expect, it, vi } from "vitest"
import start from "../../foldkit-island/client"
import renderer from "../../foldkit-island/server"
import type { SearchDoc, SearchIndexPayload } from "../../lib/docs-search"
import { MapleBrowser } from "@maple-dev/browser"
import { DocsSearch } from "./DocsSearch"
import { Array as Arr } from "effect"

const doc = (id: string, title: string, group: string, sections: SearchDoc["sections"] = []): SearchDoc => ({
	id,
	url: `/docs/${id}`,
	title,
	description: `${title} description`,
	group,
	intro: "",
	sections,
})

const index: SearchIndexPayload = {
	docs: [
		doc("explore/traces", "Traces", "Explore", [
			{ heading: "Filter traces", anchor: "filter", text: "Filter by service." },
		]),
		doc("getting-started/quickstart", "Quickstart", "Getting Started"),
		doc("explore/logs", "Logs", "Explore"),
	],
	icons: {},
}

const options = () =>
	Arr.map([...document.querySelectorAll('[role="option"]')], (option) => option.getAttribute("href"))
const press = (key: string, init: KeyboardEventInit = {}) =>
	document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }))

const mounted: Array<HTMLElement> = []

// Effect's fetch client reads `globalThis.fetch` once per process, so one stub serves every test.
const fetch = vi.fn(async () => Response.json(index))
vi.stubGlobal("fetch", fetch)

afterEach(() => {
	// Each island listens on the document until it unmounts.
	Arr.forEach(mounted.splice(0), (element) => element.dispatchEvent(new Event("astro:unmount")))
	fetch.mockReset()
	fetch.mockImplementation(async () => Response.json(index))
	vi.restoreAllMocks()
	document.body.innerHTML = ""
})

describe("DocsSearch island", () => {
	it("prefetches the index, opens on ⌘K, browses by group and ranks a query", async () => {
		const element = document.body.appendChild(document.createElement("astro-island"))
		element.innerHTML = (await renderer.renderToStaticMarkup(DocsSearch, {})).html
		expect(element.querySelector("button")?.getAttribute("aria-label")).toBe("Search docs")

		await start(element)(DocsSearch, {})
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
		press("k", { metaKey: true })
		// Browse mode: groups in the sidebar's order, pages in index order.
		await vi.waitFor(() =>
			expect(options()).toEqual([
				"/docs/getting-started/quickstart",
				"/docs/explore/traces",
				"/docs/explore/logs",
			]),
		)
		expect(
			Arr.map(
				[...document.querySelectorAll('[data-slot="command-group-label"]')],
				(label) => label.textContent,
			),
		).toEqual(["Getting Started", "Explore"])

		const input = document.querySelector('[role="combobox"]')
		expect(input).toBeInstanceOf(HTMLInputElement)
		assert(input instanceof HTMLInputElement)
		input.value = "trace"
		input.dispatchEvent(new Event("input", { bubbles: true }))
		await vi.waitFor(() =>
			expect(options()).toEqual(["/docs/explore/traces", "/docs/explore/traces#filter"]),
		)
		expect(
			Arr.map([...document.querySelectorAll('[role="option"] mark')], (mark) => mark.textContent),
		).toContain("Trace")

		input.value = "zzqxvj"
		input.dispatchEvent(new Event("input", { bubbles: true }))
		await vi.waitFor(() =>
			expect(document.querySelector('[data-slot="command-empty"]')?.textContent).toContain(
				"No results for “zzqxvj”.",
			),
		)
		// The index is fetched once per page, however often the palette opens.
		expect(fetch).toHaveBeenCalledTimes(1)
		mounted.push(element)
	})

	/** Mounts the island and opens it with ⌘K. */
	const mountOpen = async () => {
		const element = document.body.appendChild(document.createElement("astro-island"))
		mounted.push(element)
		element.innerHTML = (await renderer.renderToStaticMarkup(DocsSearch, {})).html
		await start(element)(DocsSearch, {})
		press("k", { metaKey: true })
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
		return element
	}
	/** Opens the palette over the full index and types `query`. */
	const openWith = async (query: string): Promise<HTMLInputElement> => {
		await mountOpen()
		await vi.waitFor(() => expect(options()).toHaveLength(3))
		const input = document.querySelector('[role="combobox"]')
		expect(input).toBeInstanceOf(HTMLInputElement)
		assert(input instanceof HTMLInputElement)
		input.value = query
		input.dispatchEvent(new Event("input", { bubbles: true }))
		await vi.waitFor(() => expect(options()[0]).toBe("/docs/explore/traces"))
		return input
	}
	const key = (input: HTMLInputElement, name: string) =>
		input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }))
	const isClosed = () => expect(document.querySelector('[role="dialog"]')).toBeNull()

	it("reports a dismissed search on close", async () => {
		const track = vi.spyOn(MapleBrowser, "track").mockImplementation(() => undefined)
		const input = await openWith("  trace ")
		key(input, "Escape")
		await vi.waitFor(isClosed)
		expect(track).toHaveBeenCalledExactlyOnceWith("docs_search", { query: "trace" })
	})

	it("does not report a search that opened a result", async () => {
		const track = vi.spyOn(MapleBrowser, "track").mockImplementation(() => undefined)
		const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined)
		const input = await openWith("trace")
		key(input, "Enter")
		await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/docs/explore/traces"))
		await vi.waitFor(isClosed)
		expect(track).not.toHaveBeenCalled()
	})

	it("unmounting while open removes the portal and releases the scroll lock", async () => {
		const element = await mountOpen()
		expect(document.querySelector("[data-base-ui-portal]")).not.toBeNull()
		expect(document.body.style.overflow).toBe("hidden")
		element.dispatchEvent(new Event("astro:unmount"))
		await vi.waitFor(() => expect(document.querySelector("[data-base-ui-portal]")).toBeNull())
		expect(document.body.style.overflow).toBe("")
	})

	it("fetches the index again on the next open after a failed fetch", async () => {
		let isDown = true
		fetch.mockImplementation(async () =>
			isDown ? new Response("down", { status: 503 }) : Response.json(index),
		)
		await mountOpen()
		// The idle prefetch and the first open both failed; the palette stays usable, just empty.
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
		expect(options()).toEqual([])
		press("k", { metaKey: true })
		await vi.waitFor(isClosed)
		isDown = false
		press("k", { metaKey: true })
		await vi.waitFor(() => expect(options()).toHaveLength(3))
		expect(fetch).toHaveBeenCalledTimes(3)
	})
})
