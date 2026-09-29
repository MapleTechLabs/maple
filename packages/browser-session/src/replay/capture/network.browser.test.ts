import { afterEach, describe, expect, it } from "vitest"
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
})
