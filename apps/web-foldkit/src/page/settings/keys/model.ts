import { V2ApiKey, V2IngestKeys } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { LoadFailure } from "../../../data/load-failure"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as Select from "../../../ui/select"
import * as CreateDialog from "./create-dialog"
import * as RollDialog from "./roll-dialog"

// `ApiKeysSection` (apps/web/src/components/settings/api-keys-section.tsx): every credential in one
// filterable list, the API reference and the create, roll and revoke flows.

export const KeyTypeFilter = Schema.Literals(["all", "ingest", "api", "mcp"])
export type KeyTypeFilter = typeof KeyTypeFilter.Type
export const KeyStatusFilter = Schema.Literals(["active", "expired", "revoked"])
export type KeyStatusFilter = typeof KeyStatusFilter.Type
export const IngestKeyType = Schema.Literals(["ingest_public", "ingest_private"])
export type IngestKeyType = typeof IngestKeyType.Type

export const IngestData = AsyncData.Schema(V2IngestKeys, LoadFailure)

export const Model = Schema.Struct({
	isAdmin: Schema.Boolean,
	userId: Schema.NullOr(Schema.String),
	/** `useApiKeysList()`: `null` until the shape's first answer. */
	apiKeys: Schema.NullOr(Schema.Array(V2ApiKey)),
	/** Admin-only; members never request it (`Idle`). */
	ingest: IngestData.schema,
	typeFilter: KeyTypeFilter,
	statusFilter: KeyStatusFilter,
	statusSelect: Select.Model,
	search: Schema.String,
	createMenu: Menu.Model,
	rowMenus: Schema.Record(Schema.String, Menu.Model),
	revealedIngest: Schema.Array(IngestKeyType),
	ingestCopies: Schema.Record(Schema.String, CopyButton.Model),
	revokeDialog: Dialog.Model,
	revoking: Schema.NullOr(V2ApiKey),
	isRevoking: Schema.Boolean,
	ingestRollDialog: Dialog.Model,
	ingestRollType: IngestKeyType,
	isIngestRolling: Schema.Boolean,
	roll: RollDialog.Model,
	create: CreateDialog.Model,
	baseUrlCopy: CopyButton.Model,
	isScopesOpen: Schema.Boolean,
})
export type Model = typeof Model.Type
