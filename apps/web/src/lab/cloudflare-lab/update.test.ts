import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import * as List from "../../page/infra-integrations/cloudflare/list/model"
import * as Zone from "../../page/infra-integrations/cloudflare/zone/model"
import { Message } from "./model"
import { init, update } from "./update"

const opened = () => init({ timeZone: "UTC" })

describe("cloudflare lab", () => {
	test("boots on the zone list, sending only the chart runtime and UI Commands", () => {
		const { model, commands } = opened()
		expect([model.page, model.list.search.view]).toEqual(["zones", "zones"])
		expect((commands ?? []).filter((command) => /Cloudflare/.test(command.name))).toEqual([])
	})

	test("the list's view tabs move the lab pivot, and the pivot moves the list", () => {
		const viaTabs = update(
			opened().model,
			Message.GotListMessage({ message: List.Message.ClickedView({ view: "queues" }) }),
		).model
		expect([viaTabs.page, viaTabs.list.search.view]).toEqual(["queues", "queues"])
		const viaPivot = update(viaTabs, Message.ClickedLabPage({ page: "workers" })).model
		expect([viaPivot.page, viaPivot.list.search.view]).toEqual(["workers", "workers"])
	})

	test("a zone dimension change keeps the fixture breakdown and asks the warehouse nothing", () => {
		const zone = update(opened().model, Message.ClickedLabPage({ page: "zone" })).model
		const next = update(
			zone,
			Message.GotZoneMessage({ message: Zone.Message.ClickedDimension({ dimension: "country" }) }),
		)
		expect(next.model.zone.dimension).toBe("country")
		expect(AsyncData.isSuccess(next.model.zone.breakdown.data)).toBe(true)
		expect((next.commands ?? []).map((command) => command.name)).toEqual([])
	})
})
