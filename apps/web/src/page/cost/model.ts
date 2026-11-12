import {
	CostBreakdownResponse,
	CostSourcesResponse,
	CostTimeseriesResponse,
	CostTotalsResponse,
	VercelCostStatus,
	type VercelCostTeam,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import * as Chart from "@maple/views/charts/chart"
import { ChartEnvFields } from "@maple/views/charts/chart-env"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import { TimeWindow } from "../../data/time-range"
import { CostSearch } from "../../route/search"
import * as TimeRangePicker from "../kit/time-range-picker"

export type Search = typeof CostSearch.Type

/** The add-source dialog's faces: the providers, then the chosen one's step. */
export const AddStep = Schema.Literals(["pick", "openrouter", "vercel"])
export type AddStep = typeof AddStep.Type

/** The providers whose source the page itself removes; an AWS source goes with its connection. */
export const RemovableProvider = Schema.Literals(["openrouter", "vercel"])
export type RemovableProvider = typeof RemovableProvider.Type

/**
 * What the Vercel step can do with the connection it read: only a `Ready` team can be added. A
 * team that is a source already can still have lost its token, which stops its sync.
 */
export type VercelStep =
	| Readonly<{ _tag: "NotConnected" }>
	| Readonly<{ _tag: "TokenRejected" | "Ready"; team: VercelCostTeam }>
	| Readonly<{ _tag: "Added"; team: VercelCostTeam; isTokenRejected: boolean }>

export const vercelStepOf = (status: VercelCostStatus): VercelStep => {
	if (status.team === null) return { _tag: "NotConnected" }
	return status.added
		? { _tag: "Added", team: status.team, isTokenRejected: status.authFailed }
		: { _tag: status.authFailed ? "TokenRejected" : "Ready", team: status.team }
}

export const Model = Schema.Struct({
	search: CostSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	/** The org's cost sources: they decide between the on-ramp, the first-sync wait and the reads. */
	sources: KeyedSchema(CostSourcesResponse, LoadFailure),
	totals: KeyedSchema(CostTotalsResponse, LoadFailure),
	timeseries: KeyedSchema(CostTimeseriesResponse, LoadFailure),
	breakdown: KeyedSchema(CostBreakdownResponse, LoadFailure),
	timePicker: TimeRangePicker.Model,
	chart: Chart.Model,
	...ChartEnvFields,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
	/** What the viewer's roles allow; null until the session read answers. */
	grants: Schema.NullOr(Schema.Array(Policy.PermissionName)),
	addDialog: Dialog.Model,
	addStep: AddStep,
	/** The OpenRouter management key being typed; cleared whichever way the dialog closes. */
	keyDraft: Field.Model,
	/** Why the last save was refused, shown under the field until the key changes. */
	keyError: Schema.NullOr(Schema.String),
	/** The org's Vercel connection, read when the dialog turns to Vercel. */
	vercel: KeyedSchema(VercelCostStatus, LoadFailure),
	/** Why Vercel refused the last add, shown in the step until it is left. */
	vercelError: Schema.NullOr(Schema.String),
	removeDialog: Dialog.Model,
	/** Whose source the remove dialog asks about. */
	removeProvider: RemovableProvider,
	/** `Settling`: the write answered and the sources are being read again; the list on show is the old one. */
	sourceWrite: Schema.Literals(["Idle", "Saving", "Removing", "Settling"]),
})
export type Model = typeof Model.Type

/** The saves need this permission: a viewer without it is offered no action that would be refused. */
export const canManageSources = (model: Pick<Model, "grants">): boolean =>
	model.grants !== null && Policy.has(model.grants, "integrations:manage")

/** The viewer's roles are known and lack the permission: only then does the page say who has it. */
export const cannotManageSources = (model: Pick<Model, "grants">): boolean =>
	model.grants !== null && !Policy.has(model.grants, "integrations:manage")
