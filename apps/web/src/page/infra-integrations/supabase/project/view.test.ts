import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import { decodeLogAttributeFilters } from "../../../../lib/logs/log-attribute-filters"
import type { PageContext } from "../../../contract"
import { init } from "./update"
import { projectLogsHref } from "./view"

const decodeList = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

describe("projectLogsHref", () => {
	test("opens the logs page on the project's Supabase logs over the same time range", () => {
		const { model } = init({ projectRef: "abcdefghijklmnopqrst", search: { timePreset: "6h" } }, context)
		const url = new URL(projectLogsHref(model), "https://app.maple.dev")
		expect(url.pathname).toBe("/logs")
		expect(url.searchParams.get("timePreset")).toBe("6h")
		expect(decodeList(url.searchParams.get("services"))).toEqual(["supabase"])
		expect(decodeLogAttributeFilters(decodeList(url.searchParams.get("attrs")))).toEqual([
			{
				source: "resource",
				key: "supabase.project.ref",
				value: "abcdefghijklmnopqrst",
				negated: false,
			},
		])
	})
})
