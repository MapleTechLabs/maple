import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { readAdClick } from "./ad-click"

describe("readAdClick", () => {
	it("reads the click among other cookies", () => {
		expect(readAdClick("a=1; maple_ad_click=gclid.Cj0K_x-9.1764000000000; b=2")).toEqual(
			Option.some({ type: "gclid", id: "Cj0K_x-9", clickTime: 1_764_000_000_000 }),
		)
	})

	it("ignores a missing, malformed or forged cookie", () => {
		expect(readAdClick("a=1")).toEqual(Option.none())
		expect(readAdClick("maple_ad_click=fbclid.abc.1")).toEqual(Option.none())
		expect(readAdClick("maple_ad_click=gclid.a,b.1")).toEqual(Option.none())
		expect(readAdClick("maple_ad_click=gclid.abc.soon")).toEqual(Option.none())
		expect(readAdClick("x_maple_ad_click=gclid.abc.1")).toEqual(Option.none())
	})
})
