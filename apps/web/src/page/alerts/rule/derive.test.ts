import { OrgId } from "@maple/domain"
import { AlertRuleId } from "@maple/domain/http"
import { Array as Arr, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { incidentRow, NOW, ORG, ruleId, ruleRow } from "../shared/test-rows"
import { ruleIncidentsOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

const context: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }
const iso = (msBefore: number) => new Date(NOW - msBefore).toISOString()
const incident = (id: string, rule: number, msBefore: number) =>
	incidentRow({ id, rule_id: ruleId(rule), last_triggered_at: iso(msBefore) })

const loaded = (): Model =>
	Arr.reduce(
		[
			Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2), ruleRow(3)] }),
			Message.UpdatedIncidents({
				orgId: ORG,
				rows: [
					incident("0199a003-0000-7000-8000-000000000001", 2, 60_000),
					incident("0199a003-0000-7000-8000-000000000002", 3, 30_000),
					incident("0199a003-0000-7000-8000-000000000003", 2, 10_000),
				],
			}),
		],
		init({ _tag: "AlertRule", ruleId: Schema.decodeSync(AlertRuleId)(ruleId(2)), search: {} }, context)
			.model,
		(model, message) => update(model, message, context).model,
	)

describe("ruleIncidentsOf", () => {
	test("lists only this rule's incidents, latest trigger first", () => {
		expect(Arr.map(ruleIncidentsOf(loaded()), (i) => i.id)).toEqual([
			"0199a003-0000-7000-8000-000000000003",
			"0199a003-0000-7000-8000-000000000001",
		])
	})

	test("a render with the same synced rows reuses the list", () => {
		const model = loaded()
		expect(ruleIncidentsOf({ ...model, isShowingAllIncidents: true })).toBe(ruleIncidentsOf(model))
	})
})
