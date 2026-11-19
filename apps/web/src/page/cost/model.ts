import {
	CostBreakdownResponse,
	CostSourceSummary,
	CostSourcesResponse,
	CostTimeseriesResponse,
	CostTotalsResponse,
	GcpCostStatus,
	GithubCostInstallations,
	PlanetScaleCostStatus,
	VercelCostStatus,
	type VercelCostTeam,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { VcsInstallationId } from "@maple/domain/vcs"
import { GcpConnectorId } from "@maple/primitives"
import { Option, Schema } from "effect"
import { AsyncData } from "foldkit"
import * as Chart from "@maple/views/charts/chart"
import { ChartEnvFields } from "@maple/views/charts/chart-env"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import { TimeWindow } from "../../data/time-range"
import { CostSearch } from "../../route/search"
import { CostFacets } from "./message"
import * as FeatureRequest from "../kit/feature-request"
import * as TimeRangePicker from "../kit/time-range-picker"
import { CredentialProvider } from "./providers"

export type Search = typeof CostSearch.Type

/**
 * The add-source dialog's faces: the providers, then the chosen one's credential form, list or
 * step. `request`: asking Maple for a provider it does not read yet.
 */
export const AddStep = Schema.Union([
	Schema.Literals(["pick", "github", "vercel", "planetscale", "gcp", "request"]),
	CredentialProvider,
])
export type AddStep = typeof AddStep.Type

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

/** Why PlanetScale refused an add, and whether only connecting it again fixes that. */
export const PlanetScaleAddError = Schema.Struct({ message: Schema.String, needsReconnect: Schema.Boolean })
export type PlanetScaleAddError = typeof PlanetScaleAddError.Type

/**
 * What the PlanetScale step can do with the connection it read: only a `Ready` organization can
 * be added. One that is a source already can still have lost its access to invoices, which stops
 * its sync.
 */
export type PlanetScaleStep =
	| Readonly<{ _tag: "NotConnected" }>
	| Readonly<{ _tag: "NeedsReconnect" | "Ready"; organization: string }>
	| Readonly<{ _tag: "Added"; organization: string; needsReconnect: boolean }>

export const planetScaleStepOf = (status: PlanetScaleCostStatus): PlanetScaleStep => {
	if (status.organization === null) return { _tag: "NotConnected" }
	return status.added
		? { _tag: "Added", organization: status.organization, needsReconnect: !status.invoiceAccess }
		: { _tag: status.invoiceAccess ? "Ready" : "NeedsReconnect", organization: status.organization }
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
	/** The filter rail's values per dimension. */
	facets: KeyedSchema(CostFacets, LoadFailure),
	filterSections: FilterSections.Model,
	timePicker: TimeRangePicker.Model,
	chart: Chart.Model,
	...ChartEnvFields,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
	/** What the viewer's roles allow; null until the session read answers. */
	grants: Schema.NullOr(Schema.Array(Policy.PermissionName)),
	addDialog: Dialog.Model,
	addStep: AddStep,
	/** What the provider step's search narrows the providers to; cleared whichever way the dialog opens. */
	providerSearch: Schema.String,
	/** The credential being typed (a key or a token); cleared whichever way the dialog closes. */
	credentialDraft: Field.Model,
	/** Why the last save was refused, shown under the field until the credential changes. */
	credentialError: Schema.NullOr(Schema.String),
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
	/** The org's Vercel connection, read when the dialog turns to Vercel. */
	vercel: KeyedSchema(VercelCostStatus, LoadFailure),
	/** Why Vercel refused the last add, shown in the step until it is left. */
	vercelError: Schema.NullOr(Schema.String),
	/** The org's PlanetScale connection, read when the dialog turns to PlanetScale. */
	planetscale: KeyedSchema(PlanetScaleCostStatus, LoadFailure),
	/** Why the last add of the organization was refused, shown in the step until it is left. */
	planetscaleError: Schema.NullOr(PlanetScaleAddError),
	/** The org's GCP connections and billing exports, read when the dialog turns to Google Cloud. */
	gcp: KeyedSchema(GcpCostStatus, LoadFailure),
	/** The connection the export is read through; the first that can be, until one is picked. */
	gcpConnectorId: Schema.NullOr(GcpConnectorId),
	/** The export table id being typed. */
	gcpTableDraft: Field.Model,
	/** Why the last add was refused, shown under the field until the id changes. */
	gcpError: Schema.NullOr(Schema.String),
	gcpCommandCopy: CopyButton.Model,
	/** The request step's form: a provider Maple does not read yet. */
	request: FeatureRequest.Model,
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

/** A budget is an alert rule: who manages alerts sets one. False until the session answers. */
export const canManageBudgets = (model: Pick<Model, "grants">): boolean =>
	model.grants !== null && Policy.has(model.grants, "alerts:manage")

/** The org's cost sources once read; none before. */
export const sourcesOf = (model: Pick<Model, "sources">): ReadonlyArray<CostSourceSummary> =>
	Option.getOrUndefined(AsyncData.getData(model.sources.data))?.sources ?? []
