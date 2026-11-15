import { Schema } from "effect"
import * as Keyed from "@maple/views/data/keyed"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import { ServiceDeploys } from "../model-deploys"
import { Operation } from "../model-tabs"

// The deploy drawer: one deploy's before and after, the operations it moved, where else it shipped.

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	/** The service's operations in the minutes before the deploy, every version. */
	before: KeyedSchema(Schema.Array(Operation), LoadFailure),
	/** The same operations in the deploy's first minutes, this version only being live. */
	after: KeyedSchema(Schema.Array(Operation), LoadFailure),
	/** The commit's deploys on every service and environment it reached in the window. */
	shipped: KeyedSchema(ServiceDeploys, LoadFailure),
})
export type Model = typeof Model.Type

export const init = (id: string): Model => ({
	dialog: Dialog.init(id, "sheet"),
	before: Keyed.idle(),
	after: Keyed.idle(),
	shipped: Keyed.idle(),
})
