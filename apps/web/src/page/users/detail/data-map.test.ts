import { Option } from "effect"
import { fromString } from "foldkit/url"
import { describe, expect, test } from "vitest"
import { urlToAppRoute } from "../../../route"
import { operationTracesHref } from "./data-map"

const parse = (href: string) => urlToAppRoute(Option.getOrThrow(fromString(`http://maple.test${href}`)))

describe("operationTracesHref", () => {
	test("opens /traces on the operation, the user and the page's window", () => {
		const href = operationTracesHref(
			"usr_42",
			{ service: "maple-ai", spanName: "POST /mcp" },
			{ timePreset: "7d" },
		)
		expect(parse(href)).toMatchObject({
			_tag: "Traces",
			search: {
				services: ["maple-ai"],
				spanNames: ["POST /mcp"],
				timePreset: "7d",
				attributeFilters: [
					{ key: "user.id", value: "usr_42", or: [{ key: "enduser.id", value: "usr_42" }] },
				],
			},
		})
	})
})
