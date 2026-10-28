import {
	AttributeMappingPublicId,
	RecommendationPublicId,
	V2AttributeMapping,
	V2IngestKeys,
	V2Recommendation,
} from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as Tabs from "../../../ui/tabs"
import * as IngestRules from "./ingest-rules"
import * as MappingDialog from "./mapping-dialog"
import { IngestKeyKind, OverviewRow, RecommendationTab } from "./model"

const result = <A extends Schema.Top>(schema: A) => ({ result: Schema.Result(schema, LoadFailure) })

export const Message = defineMessageUnion({
	CompletedFetchOverview: result(Schema.Array(OverviewRow)),
	CompletedFetchIngestKeys: result(V2IngestKeys),
	CompletedFetchRecommendations: result(Schema.Array(V2Recommendation)),
	CompletedFetchMappings: result(Schema.Array(V2AttributeMapping)),
	ReadFramework: { framework: Schema.NullOr(Schema.String) },
	TickedPoll: {},
	GotEndpointCopyMessage: { message: CopyButton.Message },
	ToggledKeyReveal: { kind: IngestKeyKind },
	GotKeyCopyMessage: { kind: IngestKeyKind, message: CopyButton.Message },
	ClickedRegenerateKey: { kind: IngestKeyKind },
	GotRollDialogMessage: { message: Dialog.Message },
	ClickedConfirmRoll: {},
	CompletedRollKey: { kind: IngestKeyKind, result: Schema.Result(Schema.Void, LoadFailure) },
	ClickedShowSetup: {},
	ClickedFramework: { framework: Schema.String },
	CompletedSaveFramework: {},
	GotSetupTabsMessage: { message: Tabs.Message },
	GotPackageTabsMessage: { message: Tabs.Message },
	GotSnippetCopyMessage: { snippet: Schema.String, message: CopyButton.Message },
	ClickedRecommendationTab: { tab: RecommendationTab },
	ClickedApplyRecommendation: { id: RecommendationPublicId },
	ClickedDismissRecommendation: { id: RecommendationPublicId },
	ClickedReopenRecommendation: { id: RecommendationPublicId },
	CompletedRecommendationAction: {
		id: RecommendationPublicId,
		action: Schema.Literals(["apply", "dismiss", "reopen"]),
		label: Schema.String,
		result: Schema.Result(Schema.Void, LoadFailure),
	},
	GotIngestRulesMessage: { message: IngestRules.Message },
	ClickedAddMapping: {},
	ToggledMapping: { id: AttributeMappingPublicId },
	CompletedToggleMapping: { id: AttributeMappingPublicId, result: Schema.Result(Schema.Void, LoadFailure) },
	GotRowMenuMessage: { menuId: Schema.String, message: Menu.Message },
	GotMappingDialogMessage: { message: MappingDialog.Message },
	GotDeleteDialogMessage: { message: Dialog.Message },
	ClickedConfirmDelete: {},
	CompletedDelete: { result: Schema.Result(Schema.Void, LoadFailure) },
	ClickedRetryMappings: {},
	ClickedRetryIngestKeys: {},
})
export type Message = typeof Message.Type
