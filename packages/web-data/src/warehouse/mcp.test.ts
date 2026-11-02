import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { WarehouseDecodeError } from "./effect-utils"
import { getMcpSession } from "./mcp"
import { mockedWarehouse } from "./testing"

const window = { startTime: "2026-11-01 00:00:00", endTime: "2026-11-02 00:00:00", bucketSeconds: 900 }

describe("getMcpSession", () => {
	it("fails an over-long session id as a load error before any request, instead of throwing", async () => {
		const exit = await Effect.runPromiseExit(
			mockedWarehouse(
				getMcpSession({ data: { ...window, service: "maple-ai", sessionId: "a".repeat(600) } }),
			),
		)
		expect(Exit.isFailure(exit)).toBe(true)
		const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined
		expect(failure?._tag === "Some" ? failure.value : undefined).toBeInstanceOf(WarehouseDecodeError)
	})
})
