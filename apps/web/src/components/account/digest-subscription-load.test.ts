import { DigestNotFoundError, DigestPersistenceError } from "@maple/domain/http"
import { Cause } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { describe, expect, it } from "vitest"
import { readDigestSubscription } from "./digest-subscription-load"

describe("readDigestSubscription", () => {
	it("treats a missing subscription as ready with Maple's defaults", () => {
		const result = AsyncResult.failure(Cause.fail(new DigestNotFoundError({ message: "none" })))
		expect(readDigestSubscription(result)).toEqual({ status: "ready", saved: null })
	})

	it("reports any other error as failed, so defaults never overwrite stored preferences", () => {
		const cause = Cause.fail(new DigestPersistenceError({ message: "db down" }))
		expect(readDigestSubscription(AsyncResult.failure(cause))).toEqual({ status: "failed", cause })
	})

	it("passes a loaded subscription through", () => {
		const saved = { enabled: false }
		expect(readDigestSubscription(AsyncResult.success(saved))).toEqual({ status: "ready", saved })
	})

	it("is loading before the read settles", () => {
		expect(readDigestSubscription(AsyncResult.initial()).status).toBe("loading")
	})
})
