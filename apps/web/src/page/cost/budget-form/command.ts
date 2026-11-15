import { AlertRuleId, CostBudgetCreateRequest } from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine/datetime"
import { settleTo } from "@maple/views/data/load-failure"
import { getCostBreakdown, getCostTotals } from "@maple/web-data/warehouse/cost"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { fetchSessionGrants } from "../../kit/session-grants"
import { perDimension } from "../derive"
import { createBudget, getBudget, readCostSources, updateBudget } from "../kit/budget-api"
import { type FormOptions, Message } from "./model"

// The budget editor's reads and its save.

export const ReadBudgetFormGrants = fetchSessionGrants(
	"ReadCostBudgetFormGrants",
	Message.CompletedReadGrants,
)

export const FetchExistingBudget = Command.define("FetchCostBudget", {
	args: { key: Schema.String, id: AlertRuleId },
	messages: [Message.CompletedFetchExisting],
	execute: ({ key, id }) =>
		getBudget(id).pipe(settleTo((result) => Message.CompletedFetchExisting({ key, result }))),
})

const DAY_MS = 86_400_000

/** The days the form's choices are drawn from, and how many values of a dimension it offers. */
const OPTIONS_DAYS = 30
const OPTIONS_LIMIT = 12

/**
 * What the form offers to pick: the currencies the org was billed in over the last thirty days,
 * and each dimension's largest values by cost in the main one.
 */
export const FetchBudgetFormOptions = Command.define("FetchCostBudgetFormOptions", {
	messages: [Message.CompletedFetchOptions],
	execute: Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		const window = {
			startTime: formatWarehouseDateTime(now - OPTIONS_DAYS * DAY_MS),
			endTime: formatWarehouseDateTime(now),
		}
		// The currencies decide what a new budget is created in, so their read is the one that can
		// fail. A dimension that does not answer only leaves its values off the menu.
		const [totals, sources, facets] = yield* Effect.all(
			[
				getCostTotals({ data: window }),
				readCostSources,
				Effect.all(
					perDimension((groupBy) =>
						getCostBreakdown({
							data: { ...window, groupBy, sortBy: "cost", limit: OPTIONS_LIMIT },
						}).pipe(
							Effect.map((response) => response.rows),
							Effect.orElseSucceed((): FormOptions["facets"][typeof groupBy] => []),
						),
					),
					{ concurrency: "unbounded" },
				),
			],
			{ concurrency: "unbounded" },
		)
		return { currency: totals.currency, currencies: totals.currencies, facets, sources }
	}).pipe(settleTo((result) => Message.CompletedFetchOptions({ result }))),
})

/** Creates the budget, or replaces the edited one's fields; the answer is what was stored. */
export const SaveBudget = Command.define("SaveCostBudget", {
	args: { editingId: Schema.NullOr(AlertRuleId), payload: CostBudgetCreateRequest },
	messages: [Message.CompletedSave],
	execute: ({ editingId, payload }) =>
		(editingId === null ? createBudget(payload) : updateBudget(editingId, payload)).pipe(
			settleTo((result) => Message.CompletedSave({ result })),
		),
})
