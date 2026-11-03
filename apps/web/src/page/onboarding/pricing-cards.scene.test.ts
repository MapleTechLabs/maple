import { expect as expectView, given, role, scene, text } from "foldkit/scene"
import { describe, test } from "vitest"
import { CatalogPlansResponse } from "@maple/domain/http"
import { init, PlansData, update } from "./pricing-cards"
import { view } from "./pricing-cards-view"

const loaded = { ...init(), plans: PlansData.Success({ data: CatalogPlansResponse.make({ plans: [] }) }) }

describe("PricingCards compliance", () => {
	test("the DPA is available and links to the request address", () => {
		scene(
			{ update, view },
			given(loaded),
			expectView(role("link", { name: "Request the DPA" })).toHaveAttr(
				"href",
				"mailto:privacy@maple.dev?subject=DPA%20request",
			),
		)
	})

	test("SOC 2 Type II and ISO 27001 read as in progress, not held", () => {
		scene(
			{ update, view },
			given(loaded),
			expectView(text("DPA available · SOC 2 Type II and ISO 27001 in progress")).toExist(),
		)
	})

	test("the line waits for the catalog to load", () => {
		scene({ update, view }, given(init()), expectView(role("link", { name: "Request the DPA" })).not.toExist())
	})
})
