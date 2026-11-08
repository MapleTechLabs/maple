import { OrgId } from "@maple/domain"
import { Array as Arr, Option, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { incidentRow, NOW, ORG, ruleRow } from "../shared/test-rows"
import { overviewOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

const context: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }

const loaded = (): Model =>
	Arr.reduce(
		[
			Message.ReadClock({ nowMs: NOW }),
			Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(1), ruleRow(2)] }),
			Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }),
		],
		init({ _tag: "Alerts", search: {} }, context).model,
		(model, message) => update(model, message, context).model,
	)

describe("overviewOf", () => {
	test("a message that leaves the synced rows alone reuses the derived overview", () => {
		const model = loaded()
		const typed = update(model, Message.ChangedRulesQuery({ value: "pay" }), context).model
		expect(overviewOf(typed)).toBe(overviewOf(model))
	})

	test("a new rules snapshot derives a new overview", () => {
		const model = loaded()
		const before = overviewOf(model)
		const next = update(model, Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(1)] }), context).model
		expect(Option.map(overviewOf(next), (data) => data.rules.length)).toEqual(Option.some(1))
		expect(overviewOf(next)).not.toBe(before)
	})
})
