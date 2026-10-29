import { V2AttributeMapping, V2IngestKeys, V2Recommendation } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { LoadFailure } from "../../../data/load-failure"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as Tabs from "../../../ui/tabs"
import * as IngestRules from "./ingest-rules"
import * as MappingDialog from "./mapping-dialog"

// `IngestionSection`: the ingest-health strip, the OTLP endpoint and ingest keys, install steps,
// recommendations and attribute mappings.

/** `ServiceOverview` reduced to what `useIngestConnection` reads. */
export const OverviewRow = Schema.Struct({ serviceName: Schema.String, spanCount: Schema.Number })
export type OverviewRow = typeof OverviewRow.Type

export const OverviewData = AsyncData.Schema(Schema.Array(OverviewRow), LoadFailure)
export const IngestData = AsyncData.Schema(V2IngestKeys, LoadFailure)
export const RecommendationsData = AsyncData.Schema(Schema.Array(V2Recommendation), LoadFailure)
export const MappingsData = AsyncData.Schema(Schema.Array(V2AttributeMapping), LoadFailure)

/** The org's ingest key pair: `public` for browser SDKs, `private` for servers. */
export const IngestKeyKind = Schema.Literals(["public", "private"])
export type IngestKeyKind = typeof IngestKeyKind.Type

export const RecommendationTab = Schema.Literals(["open", "closed"])
export type RecommendationTab = typeof RecommendationTab.Type

export const Model = Schema.Struct({
	isAdmin: Schema.Boolean,
	overview: OverviewData.schema,
	ingest: IngestData.schema,
	endpointCopy: CopyButton.Model,
	/** Admin-only rows: which keys are revealed, each key's copy state, and the regenerate flow. */
	revealedKeys: Schema.Array(IngestKeyKind),
	keyCopies: Schema.Record(Schema.String, CopyButton.Model),
	rollDialog: Dialog.Model,
	rollType: IngestKeyKind,
	isRolling: Schema.Boolean,
	isSetupExpanded: Schema.Boolean,
	/** The quick-start framework (`maple-onboarding-v6-<org>`), `null` until storage is read. */
	framework: Schema.String,
	setupTabs: Tabs.Model,
	packageTabs: Tabs.Model,
	snippetCopies: Schema.Record(Schema.String, CopyButton.Model),
	recommendations: RecommendationsData.schema,
	recommendationTab: RecommendationTab,
	/** Rows with an apply, dismiss or reopen in flight. */
	pendingRecommendations: Schema.Array(Schema.String),
	ingestRules: IngestRules.Model,
	mappings: MappingsData.schema,
	pendingToggles: Schema.Array(Schema.String),
	rowMenus: Schema.Record(Schema.String, Menu.Model),
	mappingDialog: MappingDialog.Model,
	deleteDialog: Dialog.Model,
	deleting: Schema.NullOr(V2AttributeMapping),
	isDeleting: Schema.Boolean,
})
export type Model = typeof Model.Type
