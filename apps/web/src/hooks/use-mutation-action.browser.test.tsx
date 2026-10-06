import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { useAsyncAction, useKeyedAsyncAction } from "./use-mutation-action"

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

describe("useKeyedAsyncAction", () => {
	afterEach(cleanup)

	it("tracks pending per key and clears each as it settles", async () => {
		const gates = new Map<string, () => void>()
		const { result } = renderHook(() =>
			useKeyedAsyncAction(
				(key: string) =>
					new Promise<string>((resolve) => {
						gates.set(key, () => resolve(key))
					}),
			),
		)
		let first: Promise<string> = Promise.resolve("")
		act(() => {
			first = result.current.run("a")
			void result.current.run("b")
		})
		expect(result.current.isPending("a")).toBe(true)
		expect(result.current.isPending("b")).toBe(true)
		expect(result.current.isPending("c")).toBe(false)

		await act(async () => {
			gates.get("a")?.()
			await first
		})
		expect(result.current.isPending("a")).toBe(false)
		expect(result.current.isPending("b")).toBe(true)
		expect(result.current.anyPending).toBe(true)

		await act(async () => {
			gates.get("b")?.()
		})
		expect(result.current.anyPending).toBe(false)
	})
})
