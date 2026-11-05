import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { decodeChartParam } from "./draft"

// Minted by the previous `btoa(unescape(encodeURIComponent(json)))` encoder: links already shared
// with teammates carry this format, so the decoder must keep reading it.
const LEGACY_LINK =
	"eyJkYXNoYm9hcmRJZCI6ImRhc2gtMSIsIndpZGdldCI6eyJpZCI6InctMSIsInZpc3VhbGl6YXRpb24iOiJjaGFydCIsImRpc3BsYXkiOnsidGl0bGUiOiJMYXRlbnogw7xiZXIgOTkgJSDwn5qAIOKckyJ9fX0"

describe("decodeChartParam", () => {
	it("reads a chart link minted by the previous encoder, non-ASCII title included", () => {
		expect(decodeChartParam(LEGACY_LINK)).toEqual(
			Option.some({
				dashboardId: "dash-1",
				widget: { id: "w-1", visualization: "chart", display: { title: "Latenz über 99 % 🚀 ✓" } },
			}),
		)
	})

	it("drops a link that is not base64url JSON instead of failing", () => {
		expect(decodeChartParam("not*base64")).toEqual(Option.none())
		expect(decodeChartParam("bm90IGpzb24")).toEqual(Option.none())
	})
})
