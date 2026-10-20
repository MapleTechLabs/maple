import {
	VercelAiGatewayResponse,
	VercelDiscoverResponse,
	VercelInfraProjectsResponse,
	VercelInfraRequestTimeseriesResponse,
	VercelProjectScope,
	VercelTeam,
} from "@maple/domain/http"
import { Schema } from "effect"
import { KeyedSchema } from "../../data/keyed"
import { LoadFailure } from "../../data/load-failure"
import * as Dialog from "../../ui/dialog"
import * as Field from "../../ui/field"
import * as RadioGroup from "../../ui/radio-group"

// The Vercel card's data shapes (shared by the Model and the Messages).

/** What the configuration dialog is open on: connecting, the drains' settings, or a new token. */
export const VercelConfigureTarget = Schema.Literals(["connect", "configure", "token"])
export type VercelConfigureTarget = typeof VercelConfigureTarget.Type

export const VercelSignal = Schema.Literals(["logsEnabled", "tracesEnabled"])
export type VercelSignal = typeof VercelSignal.Type

/** `VercelDraft` (`vercel-model.ts`) as a Schema. */
export const VercelDraftSchema = Schema.Struct({
	projectScope: VercelProjectScope,
	projectIds: Schema.Array(Schema.String),
	samplingRate: Schema.Number,
	logsEnabled: Schema.Boolean,
	tracesEnabled: Schema.Boolean,
})

export type VercelPickableProject = VercelDiscoverResponse["projects"][number]

export const VercelConfigureModel = Schema.Struct({
	target: VercelConfigureTarget,
	dialog: Dialog.Model,
	/** "Forward less from Vercel?", nested in the dialog. */
	confirm: Dialog.Model,
	token: Field.Model,
	/** The token's teams once looked up; the team step shows while there are several. */
	teams: Schema.NullOr(Schema.Array(VercelTeam)),
	team: RadioGroup.Model,
	/** The picked team's projects: the settings step shows once they are known. */
	projects: Schema.NullOr(VercelDiscoverResponse.fields.projects),
	draft: VercelDraftSchema,
	projectQuery: Schema.String,
	error: Schema.NullOr(Schema.String),
	isLookingUp: Schema.Boolean,
	isSaving: Schema.Boolean,
})
export type VercelConfigureModel = typeof VercelConfigureModel.Type

export const VercelCardModel = Schema.Struct({
	/** The card's last 24 hours (`vercelProjectsResultAtom`, `…RequestTimeseries…`, `…AiGateway…`). */
	projects: KeyedSchema(VercelInfraProjectsResponse, LoadFailure),
	timeseries: KeyedSchema(VercelInfraRequestTimeseriesResponse, LoadFailure),
	gateway: KeyedSchema(VercelAiGatewayResponse, LoadFailure),
	isSyncing: Schema.Boolean,
	isReapplying: Schema.Boolean,
	configure: Schema.NullOr(VercelConfigureModel),
})
export type VercelCardModel = typeof VercelCardModel.Type
