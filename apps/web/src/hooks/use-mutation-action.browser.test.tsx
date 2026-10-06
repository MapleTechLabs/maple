import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { useAsyncAction } from "./use-mutation-action"

describe("useAsyncAction", () => {
	afterEach(cleanup)

	it("clears pending after the action resolves", async () => {
		const { result } = renderHook(() => useAsyncAction(async (n: number) => n * 2))
		let value = 0
		await act(async () => {
			value = await result.current[0](21)
		})
		expect(value).toBe(42)
		expect(result.current[1]).toBe(false)
	})

	it("clears pending and rejects when the action throws before returning a promise", async () => {
		const { result } = renderHook(() =>
			useAsyncAction((): Promise<void> => {
				throw new Error("popup blocked")
			}),
		)
		await act(async () => {
			await expect(result.current[0]()).rejects.toThrow("popup blocked")
		})
		expect(result.current[1]).toBe(false)
	})
})
