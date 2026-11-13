import { AiCreditUsageResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { LoadFailure } from "@maple/views/data/load-failure"

export const AiCreditUsageData = AsyncData.Schema(AiCreditUsageResponse, LoadFailure)

export const Model = Schema.Struct({
	/** This cycle's AI credit spend, read on entry. */
	usage: AiCreditUsageData.schema,
})
export type Model = typeof Model.Type
