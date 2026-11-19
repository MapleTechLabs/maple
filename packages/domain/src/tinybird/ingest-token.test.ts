import { describe, expect, it } from "vitest"
import * as Datasources from "./datasources"
import { INGEST_APPEND_TOKEN, withIngestAppendToken } from "./ingest-token"

const appendLine = `TOKEN ${INGEST_APPEND_TOKEN} APPEND`

describe("ingest append token", () => {
	it.each([Datasources.traces._name, Datasources.auditTrailEvents._name, Datasources.sessionReplays._name])(
		"lets the gateway append to %s",
		(name) => {
			expect(withIngestAppendToken(name, "SCHEMA >\n    `a` String")).toContain(appendLine)
		},
	)

	it("grants nothing on a datasource the gateway never writes", () => {
		const content = "SCHEMA >\n    `a` String"
		expect(withIngestAppendToken(Datasources.sourceUsageHourly._name, content)).toBe(content)
	})
})
