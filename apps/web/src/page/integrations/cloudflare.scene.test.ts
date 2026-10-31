import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import * as ToggleGroup from "../../ui/toggle-group"
import type { PageContext } from "../contract"
import { describeCloudflareError, zoneStatus } from "./cloudflare-derive"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

describe("cloudflare card", () => {
	test("entering the card reads its usage and loads the chart runtime", () => {
		const entered = init({ search: { integration: "cloudflare" } }, context)
		expect(names(entered.commands)).toContain("LoadIntegrationsCloudflareUsage")
		expect(names(entered.commands)).toContain("LoadChartRuntime")
	})

	test("the ingest poll re-reads the clock, so a discovering connection can turn stalled", () => {
		const model = init({ search: { integration: "cloudflare" } }, context).model
		expect(names(pageUpdate(model, Message.TickedCloudflareIngest()).commands)).toContain(
			"ReadIntegrationsClock",
		)
	})

	test("zone sort flips the active column; a new column starts by its natural order", () => {
		const model = init({ search: { integration: "cloudflare" } }, context).model
		const byName = pageUpdate(model, Message.ClickedZoneSort({ key: "name" })).model
		expect(byName.cloudflareCard.zoneSort).toEqual({ key: "name", dir: "asc" })
		const flipped = pageUpdate(byName, Message.ClickedZoneSort({ key: "name" })).model
		expect(flipped.cloudflareCard.zoneSort.dir).toBe("desc")
	})

	test("unpressing the active status chip falls back to All", () => {
		const model = init({ search: { integration: "cloudflare" } }, context).model
		const live = pageUpdate(
			model,
			Message.GotZoneFilterMessage({
				message: ToggleGroup.Message.ClickedItem({ value: "live", index: 1 }),
			}),
		).model
		expect(live.cloudflareCard.zoneFilter.values).toEqual(["live"])
		const again = pageUpdate(
			live,
			Message.GotZoneFilterMessage({
				message: ToggleGroup.Message.ClickedItem({ value: "live", index: 1 }),
			}),
		).model
		expect(again.cloudflareCard.zoneFilter.values).toEqual(["all"])
	})

	test("an account-wide error pauses a zone; a zone error stays on the row", () => {
		const entry = {
			key: "z",
			name: "acme.test",
			enabled: true,
			watched: true,
			lastSyncedAt: 1,
			usage: null,
		}
		expect(zoneStatus({ ...entry, lastError: "token revoked" }, true, 10).kind).toBe("paused")
		expect(zoneStatus({ ...entry, lastError: "zone is no longer present" }, true, 10).kind).toBe("issue")
		expect(describeCloudflareError("something odd").summary).toBe("something odd")
	})
})
