import type { Html, HtmlBuilder } from "foldkit/html"
import { expect, given, scene, text, title } from "foldkit/scene"
import { describe, test } from "vitest"
import { serviceLabel, type ServiceLabelTruncate } from "./service-label"

const NAME = "openhandle-api-gateway-worker"

const viewWith =
	(truncate: ServiceLabelTruncate) =>
	(_model: null, h: HtmlBuilder<never>): Html =>
		serviceLabel(h, { serviceName: NAME, truncate })

const update = (model: null) => ({ model, commands: [] })

describe("serviceLabel", () => {
	test("a truncating name keeps the whole name on hover", () => {
		scene({ update, view: viewWith("end") }, given(null), expect(title(NAME)).toExist())
	})

	test("a middle-truncated name keeps the whole name on hover", () => {
		scene({ update, view: viewWith("middle") }, given(null), expect(title(NAME)).toExist())
	})

	test("a name that never cuts shows in full with no hover copy", () => {
		scene(
			{ update, view: viewWith("none") },
			given(null),
			expect(text(NAME)).toExist(),
			expect(title(NAME)).not.toExist(),
		)
	})
})
