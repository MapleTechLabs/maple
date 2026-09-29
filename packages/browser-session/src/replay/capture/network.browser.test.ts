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

			const [, listed, other] = events.filter((event) => event.type === "network")
			expect(listed?.attrs).toEqual({ "request.body": "request …", "response.body": '{"order"…' })
			expect(other?.attrs).toBeUndefined()
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
