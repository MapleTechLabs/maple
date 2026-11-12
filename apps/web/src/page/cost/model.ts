import {
	CostBreakdownResponse,
	CostSourceSummary,
	CostSourcesResponse,
	CostTimeseriesResponse,
	CostTotalsResponse,
	GithubCostInstallations,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { VcsInstallationId } from "@maple/domain/vcs"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
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

/** The add-source dialog's faces: the providers, then the chosen one's form or list. */
export const AddStep = Schema.Literals(["pick", "openrouter", "github"])
export type AddStep = typeof AddStep.Type

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
	/** The org's GitHub installations, read when the dialog's GitHub step opens. */
	githubInstallations: AsyncData.Schema(GithubCostInstallations, LoadFailure).schema,
	/** The number of the installations read on show: an answer to an older read is dropped. */
	githubRead: Schema.Number,
	/** The installation an add is in flight for. */
	githubAdding: Schema.NullOr(VcsInstallationId),
	/**
	 * The installation whose add failed, with the reason, shown in its row until the next try.
	 * `needsPermission`: GitHub refused the billing read, which the organization fixes in GitHub.
	 */
	githubRefusal: Schema.NullOr(
		Schema.Struct({
			installationId: VcsInstallationId,
			message: Schema.String,
			needsPermission: Schema.Boolean,
		}),
	),
	removeDialog: Dialog.Model,
	/** The source the remove confirm is about, as it was when Remove was clicked. */
	removeTarget: Schema.NullOr(CostSourceSummary),
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
