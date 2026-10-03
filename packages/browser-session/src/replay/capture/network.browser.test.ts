import { afterEach, describe, expect, it, vi } from "vitest"
import { noteStartedTraceId } from "../../events/trace-id"
import type { SessionEvent } from "../../events/events-sink"
import { installNetworkCapture } from "./network"

const originalOpen = XMLHttpRequest.prototype.open
let uninstall: (() => void) | undefined

afterEach(() => {
	uninstall?.()
	uninstall = undefined
	XMLHttpRequest.prototype.open = originalOpen
})

const request = (xhr: XMLHttpRequest): Promise<void> =>
	new Promise((resolve) => {
		// A macrotask later, so the capture's own `loadend` listener has run.
		xhr.addEventListener("loadend", () => setTimeout(resolve, 0))
		xhr.send()
	})

describe("installNetworkCapture", () => {
	it("links an XHR to a span its tracer started in open()", async () => {
		// Stands in for a tracing instrumentation installed first, which starts its span in `open`.
		const tracedOpen = originalOpen
		XMLHttpRequest.prototype.open = function (
			this: XMLHttpRequest,
			method: string,
			url: string | URL,
			async: boolean = true,
			username?: string | null,
			password?: string | null,
		) {
			noteStartedTraceId("0af7651916cd43dd8448eb211c80319c")
			tracedOpen.call(this, method, url, async, username, password)
		}
		const events: SessionEvent[] = []
		uninstall = installNetworkCapture(
			(event) => events.push(event),
			() => false,
		)

		const xhr = new XMLHttpRequest()
		xhr.open("GET", "/")
		await request(xhr)

		const network = events.find((event) => event.type === "network")
		expect(network?.traceId).toBe("0af7651916cd43dd8448eb211c80319c")
		expect(network?.net?.method).toBe("GET")
	})

	it("keeps text bodies of listed URLs only, cut to the limit", async () => {
		const realFetch = window.fetch
		// Under the capture, like the network would be.
		window.fetch = async () =>
			new Response('{"order":"12345678"}', { headers: { "content-type": "application/json" } })
		try {
			const events: SessionEvent[] = []
			uninstall = installNetworkCapture(
				(event) => events.push(event),
				() => false,
				{
					// Global on purpose: a stateful regex must still match every request.
					urls: [/\/orders/g],
					maxLength: 8,
				},
			)
			await fetch("https://api.test/orders")
			const response = await fetch("https://api.test/orders", {
				method: "POST",
				body: "request payload",
			})
			expect(await response.text()).toBe('{"order":"12345678"}')
			await fetch("https://api.test/other")
			await vi.waitFor(() => expect(events.filter((event) => event.type === "network")).toHaveLength(3))

			// Bodies are read in the background, so events can land in any order: find them by request.
			const network = events.filter((event) => event.type === "network")
			const listed = network.find((event) => event.net?.method === "POST")
			const other = network.find((event) => event.net?.url.endsWith("/other"))
			expect(listed?.attrs).toEqual({ "request.body": "request …", "response.body": '{"order"…' })
			expect(other?.attrs).toBeUndefined()
		} finally {
			uninstall?.()
			uninstall = undefined
			window.fetch = realFetch
		}
	})

	it("matches the full URL, never reads event streams, and keeps request bodies only when asked", async () => {
		const realFetch = window.fetch
		let streamed = false
		window.fetch = async (input) =>
			String(input).includes("events")
				? new Response(
						new ReadableStream({
							start() {
								streamed = true
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					)
				: new Response("ok", { headers: { "content-type": "text/plain" } })
		try {
			const events: SessionEvent[] = []
			uninstall = installNetworkCapture(
				(event) => events.push(event),
				() => false,
				{ urls: [new RegExp(`^${location.origin}/api/`)], maxLength: 100, requestBodies: false },
			)
			await fetch("/api/login", { method: "POST", body: "password=hunter2" })
			await fetch("/api/events")
			await vi.waitFor(() => expect(events.filter((event) => event.type === "network")).toHaveLength(2))

			const byUrl = (part: string) => events.find((event) => event.net?.url.includes(part))
			const login = byUrl("login")
			const stream = byUrl("events")
			expect(login?.attrs).toEqual({ "response.body": "ok" })
			expect(stream?.attrs).toBeUndefined()
			expect(streamed).toBe(true)
		} finally {
			uninstall?.()
			uninstall = undefined
			window.fetch = realFetch
		}
	})

	it("reads only as much of a large body as it keeps", async () => {
		const realFetch = window.fetch
		let pulled = 0
		const chunk = new TextEncoder().encode("x".repeat(1_000))
		window.fetch = async () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						pulled++
						if (pulled > 1_000) controller.close()
						else controller.enqueue(chunk)
					},
				}),
				{ headers: { "content-type": "text/plain" } },
			)
		try {
			const events: SessionEvent[] = []
			uninstall = installNetworkCapture(
				(event) => events.push(event),
				() => false,
				{
					urls: ["https://api.test/"],
					maxLength: 2_500,
				},
			)
			await fetch("https://api.test/big")
			await vi.waitFor(() => expect(events.some((event) => event.type === "network")).toBe(true))
			const body = events.find((event) => event.type === "network")?.attrs?.["response.body"] ?? ""
			expect(body).toHaveLength(2_501)
			expect(pulled).toBeLessThan(10)
		} finally {
			uninstall?.()
			uninstall = undefined
			window.fetch = realFetch
		}
	})
})
