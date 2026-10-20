import type { AiToolsPeriod } from "@maple/domain/http"
import { type AiToolsSelection, getAiToolTotals } from "@maple/web-data/warehouse/ai-session-tools"
import { Effect, Schema } from "effect"
import { toLoadFailure } from "../../../data/load-failure"
import type { TotalsResult } from "./model"

// The reads both tools pages make, as Effects returning the Model's shapes.

/** A read's selection as data (`toolAnalyticsSelection`'s output). */
export const Selection = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	tool: Schema.UndefinedOr(Schema.String),
	model: Schema.UndefinedOr(Schema.String),
	service: Schema.UndefinedOr(Schema.String),
	env: Schema.UndefinedOr(Schema.String),
	search: Schema.UndefinedOr(Schema.String),
	failingOnly: Schema.UndefinedOr(Schema.Boolean),
})
export type Selection = typeof Selection.Type

export const toInput = (selection: Selection): AiToolsSelection => ({ ...selection })

/** `aiToolTotalsResultAtom`; `periods` absent asks for the comparison window and the population too. */
export const fetchTotals = (selection: Selection, periods?: ReadonlyArray<AiToolsPeriod>) =>
	getAiToolTotals({ data: { ...toInput(selection), periods } }).pipe(
		Effect.map((value): TotalsResult => ({
			current: value.current,
			previous: value.previous,
			allSessions: value.allSessions,
			firstSeen: value.firstSeen,
			lastSeen: value.lastSeen,
			description: value.description,
		})),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)
