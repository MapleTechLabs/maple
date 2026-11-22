import { Option } from "effect"
import { fromString } from "foldkit/url"
import { describe, expect, test } from "vitest"
import { urlToAppRoute } from "../../../route"
import { operationTracesHref } from "./data-map"

const parse = (href: string) => urlToAppRoute(Option.getOrThrow(fromString(`http://maple.test${href}`)))

const OPERATION = { service: "maple-ai", spanName: "POST /mcp" }
const USER_FILTER = { key: "user.id", value: "usr_42", or: [{ key: "enduser.id", value: "usr_42" }] }

describe("operationTracesHref", () => {
	test("opens the span view of the operation and user over the page's resolved window", () => {
		const href = operationTracesHref(
			"usr_42",
			OPERATION,
			{},
			{ startTime: "2026-11-15 12:00:00", endTime: "2026-11-22 12:00:00" },
		)
		expect(parse(href)).toMatchObject({
			_tag: "Traces",
			search: {
				services: ["maple-ai"],
				spanNames: ["POST /mcp"],
				rootOnly: false,
				startTime: "2026-11-15 12:00:00",
				endTime: "2026-11-22 12:00:00",
				attributeFilters: [USER_FILTER],
			},
		})
	})

	test("keeps the namespace picked on the page, and the URL window until one resolves", () => {
		const href = operationTracesHref("usr_42", OPERATION, { namespace: "core", timePreset: "7d" }, null)
		expect(parse(href)).toMatchObject({
			_tag: "Traces",
			search: { namespaces: ["core"], timePreset: "7d", attributeFilters: [USER_FILTER] },
		})
	})
})
