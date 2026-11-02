import { AsyncData } from "foldkit"
import { describe, expect, it } from "vitest"
import { dataFor } from "./view"

const forServer = (service: string) => (value: { service: string }) => value.service === service

describe("dataFor", () => {
	it("reads another server's retained answer as loading", () => {
		const retained = AsyncData.Refreshing({ data: { service: "maple-ai" } })
		expect(AsyncData.isLoading(dataFor(retained, forServer("maple-api")))).toBe(true)
	})

	it("keeps this server's answer while a filter change refreshes it", () => {
		const retained = AsyncData.Refreshing({ data: { service: "maple-ai" } })
		expect(dataFor(retained, forServer("maple-ai"))).toBe(retained)
	})

	it("leaves a failure as it is", () => {
		const failed = AsyncData.Failure({ error: "boom" })
		expect(dataFor(failed, forServer("maple-ai"))).toBe(failed)
	})
})
