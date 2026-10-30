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

/** `open` as the browser takes it: the DOM types allow only a string or a URL, the browser any value. */
type AnyUrl = string | URL | null | { toString(): string }
interface AnyUrlOpen {
	open(method: string, url: AnyUrl): void
}
const openAny = (xhr: AnyUrlOpen, url: AnyUrl): void => xhr.open("GET", url)

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

	it("blanks credential-looking values in kept bodies, even in a body cut short", async () => {
		const realFetch = window.fetch
		window.fetch = async () =>
			new Response(
				'{"user":"ada","access_token":"eyJhbGciOi.secret","refresh":{"apiKey":"k-123"},"note":"x"}',
				{
					headers: { "content-type": "application/json" },
				},
			)
		try {
			const events: SessionEvent[] = []
			uninstall = installNetworkCapture(
				(event) => events.push(event),
				() => false,
				{ urls: ["https://api.test/"], maxLength: 1_000 },
			)
			await fetch("https://api.test/login", {
				method: "POST",
				body: "username=ada&password=hunter2&remember=1",
			})
			await vi.waitFor(() => expect(events.some((event) => event.type === "network")).toBe(true))
			const attrs = events.find((event) => event.type === "network")?.attrs ?? {}
			expect(attrs["request.body"]).toBe("username=ada&password=[REDACTED]&remember=1")
			expect(attrs["response.body"]).toBe(
				'{"user":"ada","access_token":"[REDACTED]","refresh":{"apiKey":"[REDACTED]"},"note":"x"}',
			)
		} finally {
			uninstall?.()
			uninstall = undefined
			window.fetch = realFetch
		}
	})

	it("blanks a credential key's whole value when it is an object, and a bare pass field", async () => {
		const realFetch = window.fetch
		window.fetch = async () =>
			new Response(
				'{"password":{"current":"hunter2","next":"hunter3"},"user":"ada","raw":"user=ada&pass=hunter5"}',
				{
					headers: { "content-type": "application/json" },
				},
			)
		try {
			const events: SessionEvent[] = []
			uninstall = installNetworkCapture(
				(event) => events.push(event),
				() => false,
				{ urls: ["https://api.test/"], maxLength: 1_000, requestBodies: true },
			)
			await fetch("https://api.test/login", { method: "POST", body: "user=ada&pass=hunter4" })
			await vi.waitFor(() => expect(events.some((event) => event.type === "network")).toBe(true))
			const attrs = events.find((event) => event.type === "network")?.attrs ?? {}
			// A string value holding a form body is redacted too, and the JSON stays valid.
			expect(attrs["response.body"]).toBe(
				'{"password":"[REDACTED]","user":"ada","raw":"user=ada&pass=[REDACTED]"}',
			)
			expect(attrs["request.body"]).toBe("user=ada&pass=[REDACTED]")
		} finally {
			uninstall?.()
			uninstall = undefined
			window.fetch = realFetch
		}
	})

	it("opens an XHR whose URL is null or an object with its own toString, as the browser does", async () => {
		const events: SessionEvent[] = []
		uninstall = installNetworkCapture(
			(event) => events.push(event),
			() => false,
		)
		const xhr = new XMLHttpRequest()
		openAny(xhr, { toString: () => "/?from-object" })
		await request(xhr)
		const nullXhr = new XMLHttpRequest()
		// The native method coerces `null` to "null", a relative URL.
		openAny(nullXhr, null)
		await request(nullXhr)
		expect(events.map((event) => event.net?.url)).toEqual(["/?from-object", "null"])
	})
})

describe("installNetworkCapture next to the app's own wrappers", () => {
	const realFetch = window.fetch
	afterEach(() => {
		window.fetch = realFetch
		XMLHttpRequest.prototype.send = originalSend
	})
	const originalSend = XMLHttpRequest.prototype.send
	const base = async () => new Response("ok", { headers: { "content-type": "text/plain" } })

	it("keeps a fetch wrapper installed after it working once capture is torn down", async () => {
		window.fetch = base
		const events: SessionEvent[] = []
		const stop = installNetworkCapture(
			(event) => events.push(event),
			() => false,
		)
		// An auth interceptor installed later, on top of the capture.
		const seen: string[] = []
		const underneath = window.fetch
		const interceptor: typeof fetch = (input, init) => {
			seen.push(String(input))
			return underneath(input, init)
		}
		window.fetch = interceptor
		stop()

		expect(window.fetch).toBe(interceptor)
		expect(await (await fetch("https://api.test/after")).text()).toBe("ok")
		expect(seen).toEqual(["https://api.test/after"])
		// Torn down, the capture underneath only forwards.
		expect(events).toEqual([])
	})

	it("restores the original when nothing was installed on top", () => {
		window.fetch = base
		XMLHttpRequest.prototype.send = originalSend
		const stop = installNetworkCapture(
			() => {},
			() => false,
		)
		stop()
		expect(window.fetch).toBe(base)
		expect(XMLHttpRequest.prototype.send).toBe(originalSend)
	})

	it("does not grow the chain across repeated starts and stops under a foreign wrapper", async () => {
		window.fetch = base
		let depth = 0
		const counting =
			(inner: typeof fetch): typeof fetch =>
			(input, init) => {
				depth++
				return inner(input, init)
			}
		const first = installNetworkCapture(
			() => {},
			() => false,
		)
		const foreign = counting(window.fetch)
		window.fetch = foreign
		first()
		const events: SessionEvent[] = []
		for (let i = 0; i < 10; i++)
			installNetworkCapture(
				(event) => events.push(event),
				() => false,
			)()
		const stop = installNetworkCapture(
			(event) => events.push(event),
			() => false,
		)
		// The wrapper left under the foreign one is reused, not stacked on top again.
		expect(window.fetch).toBe(foreign)
		await fetch("https://api.test/once")
		stop()
		expect(depth).toBe(1)
		expect(events.filter((event) => event.type === "network")).toHaveLength(1)
	})
})
