import { beforeEach, describe, expect, it } from "vitest"
import { WarehouseQuotaExceededError } from "@maple/domain/http"
import { HttpClientError, HttpClientRequest } from "effect/http"
import {
	isBlipping,
	noteReachable,
	noteUnreachable,
	originOf,
	PEER_OUTAGE_GRACE_MS,
} from "../lib/peer-reachability"
import {
	isRequestTimeout,
	WarehouseDecodeError,
	WarehouseQueryError,
	WarehouseUnreachableError,
	normalizeWarehouseError,
} from "./effect-utils"

const apiBaseUrl = "https://api.maple.test"

describe("normalizeWarehouseError", () => {
	it("preserves a v2 error envelope", () => {
		const quota = new WarehouseQuotaExceededError({
			message: "internal",
			pipeName: "getReplayEvents",
			setting: "max_execution_time",
		})
		const error = {
			error: quota.error,
		}
		expect(normalizeWarehouseError("getReplayEvents", error)).toBe(error)
	})

	it("preserves self-describing backend and local warehouse errors", () => {
		const backend = new WarehouseQuotaExceededError({
			message: "internal",
			pipeName: "query",
			setting: "max_memory_usage",
		})
		const local = new WarehouseDecodeError({ operation: "decode", message: "invalid input" })
		expect(normalizeWarehouseError("query", backend)).toBe(backend)
		expect(normalizeWarehouseError("query", local)).toBe(local)
		expect(local.error.title).toBe("Query data could not be read")
	})

	it("wraps an unstructured failure exactly once", () => {
		const cause = new Error("transport failed")
		const normalized = normalizeWarehouseError("query", cause)
		expect(normalized).toBeInstanceOf(WarehouseQueryError)
		if (!(normalized instanceof WarehouseQueryError)) throw new Error("expected WarehouseQueryError")
		expect(normalized.message).toBe("transport failed")
		expect(normalized.cause).toBe(cause)
		expect(normalizeWarehouseError("query", normalized)).toBe(normalized)
	})
})

const transportFailure = () =>
	new HttpClientError.HttpClientError({
		reason: new HttpClientError.TransportError({
			request: HttpClientRequest.post(`${apiBaseUrl}/internal/query-engine/execute-batch`),
			cause: new TypeError("Failed to fetch"),
		}),
	})

/**
 * A dropped connection is the network, not the warehouse — but only while it is
 * still short enough to be a blip. Past the grace window the API is genuinely
 * unreachable and the failure reports exactly as it did before.
 */
describe("transport failures during a connectivity blip", () => {
	const origin = originOf(apiBaseUrl)
	// What `ApiReachability` answers in apps/web for its API origin.
	const blipping = () => isBlipping(origin, Date.now())

	beforeEach(() => {
		noteReachable(origin)
	})

	it("classifies a transport failure as unreachable while the origin is blipping", () => {
		noteUnreachable(origin, Date.now())

		const normalized = normalizeWarehouseError("query", transportFailure(), blipping())

		expect(normalized).toBeInstanceOf(WarehouseUnreachableError)
		if (!(normalized instanceof WarehouseUnreachableError)) throw new Error("expected unreachable")
		// The user is told the API is unreachable and that it retries — never that
		// their query needs fixing.
		expect(normalized.error.title).toBe("Cannot reach Maple API")
		expect(normalized.error.retryable).toBe(true)
	})

	it("unwraps a transport failure nested behind another error", () => {
		noteUnreachable(origin, Date.now())
		const wrapped = new Error("Warehouse batch request failed", { cause: transportFailure() })

		expect(normalizeWarehouseError("query", wrapped, blipping())).toBeInstanceOf(
			WarehouseUnreachableError,
		)
	})

	it("reports a transport failure once the outage outlasts the grace window", () => {
		noteUnreachable(origin, Date.now() - PEER_OUTAGE_GRACE_MS - 1)

		expect(normalizeWarehouseError("query", transportFailure(), blipping())).toBeInstanceOf(
			WarehouseQueryError,
		)
	})

	it("leaves a failure the API actually answered alone, blip or not", () => {
		noteUnreachable(origin, Date.now())

		expect(normalizeWarehouseError("query", new Error("decode failed"), blipping())).toBeInstanceOf(
			WarehouseQueryError,
		)
	})
})

describe("isRequestTimeout", () => {
	const request = HttpClientRequest.get(`${apiBaseUrl}/v2/execute`)
	const transport = (cause: unknown) =>
		new HttpClientError.HttpClientError({
			reason: new HttpClientError.TransportError({ request, description: "failed", cause }),
		})

	it("recognises the client deadline, also when a caller wrapped it", () => {
		const timedOut = transport(new DOMException("No response within 45000ms", "TimeoutError"))
		expect(isRequestTimeout(timedOut)).toBe(true)
		expect(
			isRequestTimeout(
				new WarehouseUnreachableError({ operation: "execute", message: "x", cause: timedOut }),
			),
		).toBe(true)
	})

	it("a dropped connection is not a timeout", () => {
		expect(isRequestTimeout(transport(new TypeError("Failed to fetch")))).toBe(false)
	})
})
