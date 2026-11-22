import { ErrorIssueSampleTrace } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import { occurrenceColumnsOf } from "./view-tables"

// The occurrences table drops a column that says the same thing on every row, and keeps a
// release or user column as soon as one sample carries one.

const decodeSample = Schema.decodeUnknownSync(ErrorIssueSampleTrace)

const sample = (overrides: Partial<Record<string, unknown>>) =>
	decodeSample({
		traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
		spanId: "00f067aa0ba902b7",
		serviceName: "checkout-api",
		timestamp: "2026-11-01T12:00:00.000Z",
		exceptionMessage: "upstream timed out",
		durationMicros: 1500,
		deploymentEnv: "production",
		serviceVersion: "",
		userId: "",
		...overrides,
	})

describe("occurrence columns", () => {
	test("samples that agree on service, message and environment show none of those columns", () => {
		expect(occurrenceColumnsOf([sample({}), sample({})])).toEqual({
			service: false,
			message: false,
			environment: false,
			release: false,
			user: false,
		})
	})

	test("differing values bring their column back", () => {
		const columns = occurrenceColumnsOf([
			sample({ serviceName: "api", deploymentEnv: "staging" }),
			sample({ exceptionMessage: "user 42 not found" }),
		])
		expect(columns).toMatchObject({ service: true, message: true, environment: true })
	})

	test("one sample with a release or a user is enough for its column", () => {
		const columns = occurrenceColumnsOf([
			sample({ serviceVersion: "1.4.2", userId: "usr_1" }),
			sample({}),
		])
		expect(columns).toMatchObject({ release: true, user: true })
	})
})
