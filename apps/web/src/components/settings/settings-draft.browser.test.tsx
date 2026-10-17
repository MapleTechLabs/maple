import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { useSettingsDraft } from "./settings-draft"

interface Form {
	readonly rate: number
}

const renderDraft = (initial: Form) =>
	renderHook(({ saved }: { saved: Form }) => useSettingsDraft(saved), {
		initialProps: { saved: initial },
	})

describe("useSettingsDraft commit", () => {
	afterEach(cleanup)

	it("keeps showing the saved edits until the refetch returns them", () => {
		const { result, rerender } = renderDraft({ rate: 10 })
		act(() => result.current.setDraft({ rate: 50 }))
		expect(result.current.isDirty).toBe(true)

		act(() => result.current.commit({ submitted: { rate: 50 } }))
		expect(result.current.draft).toEqual({ rate: 50 })
		expect(result.current.isDirty).toBe(false)

		rerender({ saved: { rate: 10 } })
		expect(result.current.draft).toEqual({ rate: 50 })

		rerender({ saved: { rate: 50 } })
		expect(result.current.draft).toEqual({ rate: 50 })
		expect(result.current.isDirty).toBe(false)

		rerender({ saved: { rate: 70 } })
		expect(result.current.draft).toEqual({ rate: 70 })
	})

	it("follows a server value that differs from the edits once it changes", () => {
		const { result, rerender } = renderDraft({ rate: 10 })
		act(() => result.current.setDraft({ rate: 55 }))
		act(() => result.current.commit({ submitted: { rate: 55 } }))

		rerender({ saved: { rate: 50 } })
		expect(result.current.draft).toEqual({ rate: 50 })
		expect(result.current.isDirty).toBe(false)
	})

	it("treats an edit after commit as a fresh dirty draft", () => {
		const { result } = renderDraft({ rate: 10 })
		act(() => result.current.setDraft({ rate: 50 }))
		act(() => result.current.commit({ submitted: { rate: 50 } }))
		act(() => result.current.updateDraft((current) => ({ rate: current.rate + 1 })))
		expect(result.current.draft).toEqual({ rate: 51 })
		expect(result.current.isDirty).toBe(true)
	})

	it("releases the edits when the save normalized them to the stored value", () => {
		const { result, rerender } = renderDraft({ rate: 50 })
		act(() => result.current.setDraft({ rate: 50.0001 }))
		expect(result.current.isDirty).toBe(true)

		act(() => result.current.commit({ submitted: { rate: 50.0001 }, sent: { rate: 50 } }))
		rerender({ saved: { rate: 50 } })
		expect(result.current.draft).toEqual({ rate: 50 })
		expect(result.current.isDirty).toBe(false)

		rerender({ saved: { rate: 60 } })
		expect(result.current.draft).toEqual({ rate: 60 })
	})

	it("keeps the edits while the stored value matches neither the edits nor the sent value", () => {
		const { result, rerender } = renderDraft({ rate: 10 })
		act(() => result.current.setDraft({ rate: 25.5 }))
		act(() => result.current.commit({ submitted: { rate: 25.5 }, sent: { rate: 25 } }))
		rerender({ saved: { rate: 10 } })
		expect(result.current.draft).toEqual({ rate: 25.5 })
		expect(result.current.isDirty).toBe(false)
	})

	it("keeps an edit made while the save was in flight dirty after the refetch", () => {
		const { result, rerender } = renderDraft({ rate: 10 })
		act(() => result.current.setDraft({ rate: 50 }))
		const submitted = result.current.draft
		act(() => result.current.setDraft({ rate: 60 }))

		act(() => result.current.commit({ submitted }))
		expect(result.current.isDirty).toBe(true)

		rerender({ saved: { rate: 50 } })
		expect(result.current.draft).toEqual({ rate: 60 })
		expect(result.current.isDirty).toBe(true)
	})

	it("keeps an in-flight edit dirty when the save normalized the submitted value", () => {
		const { result, rerender } = renderDraft({ rate: 10 })
		act(() => result.current.setDraft({ rate: 25.5 }))
		act(() => result.current.setDraft({ rate: 30 }))
		act(() => result.current.commit({ submitted: { rate: 25.5 }, sent: { rate: 25 } }))

		rerender({ saved: { rate: 25 } })
		expect(result.current.draft).toEqual({ rate: 30 })
		expect(result.current.isDirty).toBe(true)
	})

	it("keeps a revert to the saved value dirty while the save that stores the edit is in flight", () => {
		const { result, rerender } = renderDraft({ rate: 10 })
		act(() => result.current.setDraft({ rate: 50 }))
		let submitted = result.current.draft
		act(() => {
			submitted = result.current.submit()
		})
		expect(submitted).toEqual({ rate: 50 })
		act(() => result.current.setDraft({ rate: 10 }))
		expect(result.current.isDirty).toBe(true)

		act(() => result.current.commit({ submitted }))
		expect(result.current.isDirty).toBe(true)

		rerender({ saved: { rate: 50 } })
		expect(result.current.draft).toEqual({ rate: 10 })
		expect(result.current.isDirty).toBe(true)
	})

	it("abort keeps a reverted edit clean when the save failed", () => {
		const { result } = renderDraft({ rate: 10 })
		act(() => result.current.setDraft({ rate: 50 }))
		act(() => {
			result.current.submit()
		})
		act(() => result.current.setDraft({ rate: 10 }))
		expect(result.current.isDirty).toBe(true)

		act(() => result.current.abort())
		expect(result.current.draft).toEqual({ rate: 10 })
		expect(result.current.isDirty).toBe(false)
	})

	it("abort keeps an unsaved edit dirty", () => {
		const { result } = renderDraft({ rate: 10 })
		act(() => result.current.setDraft({ rate: 50 }))
		act(() => {
			result.current.submit()
		})
		act(() => result.current.abort())
		expect(result.current.draft).toEqual({ rate: 50 })
		expect(result.current.isDirty).toBe(true)
	})

	it("discard still drops the edits immediately", () => {
		const { result } = renderDraft({ rate: 10 })
		act(() => result.current.setDraft({ rate: 50 }))
		act(() => result.current.discard())
		expect(result.current.draft).toEqual({ rate: 10 })
		expect(result.current.isDirty).toBe(false)
	})
})
