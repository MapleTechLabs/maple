import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { isRejected, refusalMessageOf } from "./command"

// The v2 client fails with the decoded wire envelope; the collection wraps it in `cause` chains.
const envelope = (type: string) => ({
	error: {
		_tag: "DashboardConcurrencyError",
		type,
		code: "dashboard_concurrent_update",
		title: "Dashboard changed",
		message: "Someone else changed this dashboard",
		retryable: false,
		recovery: "refresh",
	},
})
const wrapped = (inner: unknown) => ({ message: "Update operation failed", cause: { cause: inner } })

describe("isRejected", () => {
	test("a refused write (invalid, missing, conflicting) leaves the store writable", () => {
		expect(isRejected(envelope("conflict_error"))).toBe(true)
		expect(isRejected(wrapped(envelope("invalid_request_error")))).toBe(true)
		expect(isRejected(wrapped(envelope("not_found_error")))).toBe(true)
	})

	test("auth, outage and transport failures still lock the store", () => {
		expect(isRejected(wrapped(envelope("authentication_error")))).toBe(false)
		expect(isRejected(wrapped(envelope("api_error")))).toBe(false)
		expect(isRejected(wrapped({ message: "Failed to fetch" }))).toBe(false)
	})

	test("a refusal's own message reaches the toast", () => {
		expect(refusalMessageOf(wrapped(envelope("conflict_error")))).toEqual(
			Option.some("Someone else changed this dashboard"),
		)
		expect(refusalMessageOf(wrapped({ message: "Failed to fetch" }))).toEqual(Option.none())
	})
})
