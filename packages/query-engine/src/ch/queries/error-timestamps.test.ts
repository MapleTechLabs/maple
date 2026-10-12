import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { compile } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import {
	errorFingerprintSummaryQuery,
	errorIssueSampleTracesQuery,
	errorIssueTimeseriesQuery,
	errorIssuesQuery,
	errorsByTypeQuery,
	errorsSparkQuery,
	errorsTimeseriesQuery,
	errorTickBootstrapIssuesQuery,
	errorTickFirstErrorMinuteQuery,
	errorTickIssuesQuery,
} from "./errors"
import { anomalyErrorSpikeServiceTimeseriesQuery, anomalyErrorSpikeTimeseriesQuery } from "./anomaly"
import { releaseErrorFingerprintsQuery } from "./releases"

// Rows reach callers through `decodeRows`. A query whose row schema is not
// derived passes rows through untouched, and its timestamps would stay strings
// behind a `DateTime.Utc` type.

const params = {
	orgId: OrgId.make("org_1"),
	startTime: DateTime.makeUnsafe("2024-01-01T00:00:00.750Z"),
	endTime: DateTime.makeUnsafe("2024-01-02T00:00:00Z"),
	bucketSeconds: 60,
	fingerprintHash: "42",
	serviceName: "api",
	deploymentEnv: "production",
	serviceVersion: "abc123",
}

const iso = (value: unknown) => (DateTime.isDateTime(value) ? DateTime.formatIso(value) : value)

const issueRow = {
	fingerprintHash: "42",
	serviceName: "api",
	exceptionType: "Error",
	exceptionMessage: "boom",
	errorLabel: "Error",
	topFrame: "",
	count: "3",
	firstSeen: "2024-01-01 10:00:00",
	lastSeen: "2024-01-01 11:30:05",
}

describe("error queries decode timestamps to DateTime.Utc", () => {
	it.effect("floors DateTime.Utc bounds to whole seconds on the DateTime columns", () =>
		Effect.gen(function* () {
			const { sql } = yield* compile(errorTickIssuesQuery(), params)
			expect(sql).toContain("Minute >= '2024-01-01 00:00:00'")
			expect(sql).toContain("Minute < '2024-01-02 00:00:00'")
		}),
	)

	const cases = [
		{
			name: "errorsByTypeQuery",
			compiled: compile(errorsByTypeQuery({}), params),
			row: {
				fingerprintHash: "42",
				errorLabel: "Error",
				sampleMessage: "boom",
				count: "3",
				affectedServicesCount: "1",
				serviceNames: ["api"],
				firstSeen: "2024-01-01 10:00:00",
				lastSeen: "2024-01-01 11:30:05",
			},
			fields: { firstSeen: "2024-01-01T10:00:00.000Z", lastSeen: "2024-01-01T11:30:05.000Z" },
		},
		{
			name: "errorsTimeseriesQuery",
			compiled: compile(errorsTimeseriesQuery({ fingerprintHash: "42" }), params),
			row: { bucket: "2024-01-01 10:00:00", count: "3" },
			fields: { bucket: "2024-01-01T10:00:00.000Z" },
		},
		{
			name: "errorsSparkQuery",
			compiled: compile(errorsSparkQuery({ fingerprintHashes: ["42"] }), params),
			row: { fingerprintHash: "42", bucket: "2024-01-01 10:00:00", count: "3" },
			fields: { bucket: "2024-01-01T10:00:00.000Z" },
		},
		{
			name: "errorIssuesQuery",
			compiled: compile(errorIssuesQuery({}), params),
			row: { ...issueRow, affectedServicesCount: "1" },
			fields: { firstSeen: "2024-01-01T10:00:00.000Z", lastSeen: "2024-01-01T11:30:05.000Z" },
		},
		{
			name: "errorTickIssuesQuery",
			compiled: compile(errorTickIssuesQuery(), params),
			row: { ...issueRow, serviceVersions: ["1.0.0"] },
			fields: { firstSeen: "2024-01-01T10:00:00.000Z", lastSeen: "2024-01-01T11:30:05.000Z" },
		},
		{
			name: "errorTickBootstrapIssuesQuery",
			compiled: compile(errorTickBootstrapIssuesQuery(), params),
			row: { ...issueRow, serviceVersions: ["1.0.0"] },
			fields: { firstSeen: "2024-01-01T10:00:00.000Z", lastSeen: "2024-01-01T11:30:05.000Z" },
		},
		{
			name: "errorTickFirstErrorMinuteQuery",
			compiled: compile(errorTickFirstErrorMinuteQuery(), params),
			row: { minute: "2024-01-01 10:07:00" },
			fields: { minute: "2024-01-01T10:07:00.000Z" },
		},
		{
			name: "errorIssueTimeseriesQuery",
			compiled: compile(errorIssueTimeseriesQuery(), params),
			row: { bucket: "2024-01-01 10:00:00", count: "3" },
			fields: { bucket: "2024-01-01T10:00:00.000Z" },
		},
		{
			name: "errorIssueSampleTracesQuery",
			compiled: compile(errorIssueSampleTracesQuery({}), params),
			row: {
				traceId: "t1",
				spanId: "s1",
				serviceName: "api",
				timestamp: "2024-01-01 10:00:01",
				exceptionMessage: "boom",
				durationMicros: "12",
			},
			fields: { timestamp: "2024-01-01T10:00:01.000Z" },
		},
		{
			name: "errorFingerprintSummaryQuery",
			compiled: compile(errorFingerprintSummaryQuery({ fingerprintHash: "42" }), params),
			row: {
				occurrences: "3",
				firstSeen: "2024-01-01 10:00:00",
				lastSeen: "2024-01-01 11:30:05",
				errorLabel: "Error",
				exceptionType: "Error",
				exceptionMessage: "boom",
				statusMessage: "",
				serviceCount: "1",
				services: ["api"],
				noExceptionCount: "0",
			},
			fields: { firstSeen: "2024-01-01T10:00:00.000Z", lastSeen: "2024-01-01T11:30:05.000Z" },
		},
		{
			name: "anomalyErrorSpikeTimeseriesQuery",
			compiled: compile(anomalyErrorSpikeTimeseriesQuery(), params),
			row: { bucket: "2024-01-01 10:05:00", count: "3" },
			fields: { bucket: "2024-01-01T10:05:00.000Z" },
		},
		{
			name: "anomalyErrorSpikeServiceTimeseriesQuery",
			compiled: compile(anomalyErrorSpikeServiceTimeseriesQuery(), params),
			row: { bucket: "2024-01-01 10:05:00", count: "3" },
			fields: { bucket: "2024-01-01T10:05:00.000Z" },
		},
		{
			name: "releaseErrorFingerprintsQuery",
			compiled: compile(releaseErrorFingerprintsQuery({ serviceName: "api" }), params),
			row: { fingerprintHash: "42", count: "3", firstSeen: "2024-01-01 10:00:00" },
			fields: { firstSeen: "2024-01-01T10:00:00.000Z" },
		},
	]

	for (const { name, compiled: compileCase, row, fields } of cases) {
		it.effect(name, () =>
			Effect.gen(function* () {
				const compiled = yield* compileCase
				expect(compiled.rowSchemaSource).toBe("derived")
				const [decoded] = yield* compiled.decodeRows([row])
				const actual = Object.fromEntries(
					Object.entries(decoded ?? {})
						.filter(([key]) => key in fields)
						.map(([key, value]) => [key, iso(value)]),
				)
				expect(actual).toEqual(fields)
			}),
		)
	}
})
