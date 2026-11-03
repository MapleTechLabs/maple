import { all, expect as expectView, given, nth, role, scene, text } from "foldkit/scene"
import { describe, test } from "vitest"
import { CatalogPlansResponse } from "@maple/domain/http"
import { init, PlansData, update } from "./pricing-cards"
import { view } from "./pricing-cards-view"

const loaded = { ...init(), plans: PlansData.Success({ data: CatalogPlansResponse.make({ plans: [] }) }) }
const rows = all.role("listitem")

describe("PricingCards compliance", () => {
	test("the DPA is available and links to the request address", () => {
		scene(
			{ update, view },
			given(loaded),
			expectView(nth(rows, 0)).toHaveText("DPAAvailable"),
			expectView(role("link", { name: "DPA" })).toHaveAttr(
				"href",
				"mailto:privacy@maple.dev?subject=DPA%20request",
			),
		)
	})

	test("SOC 2 Type II and ISO 27001 read as in progress, not held", () => {
		scene(
			{ update, view },
			given(loaded),
			expectView(nth(rows, 1)).toHaveText("SOC 2 Type IIIn progress"),
			expectView(nth(rows, 2)).toHaveText("ISO 27001In progress"),
		)
	})

	test("the list waits for the catalog to load", () => {
		scene({ update, view }, given(init()), expectView(text("Compliance")).not.toExist())
	})
})
