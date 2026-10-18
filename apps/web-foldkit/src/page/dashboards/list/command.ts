import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { Clock, Duration, Effect, Option, Result, Schema } from "effect"
import { Command, Dom } from "foldkit"
import { File as FoldkitFile } from "foldkit/file"
import { MapleApiV2Client } from "../../../platform/api-clients"
import {
	DASHBOARD_FAVORITES_EVENT,
	DASHBOARD_FAVORITES_KEY,
	readDashboardFavorites,
} from "../../../shell/favorites"
import {
	createPayload,
	downloadPortable,
	isPersesDashboardJson,
	type PortableDashboard,
	parsePortable,
	toPortable,
} from "../kit/portable"
import { awaitTxid, deleteDashboard, errorMessageOf, mutateDashboard, readDocument } from "../kit/store"
import { Message } from "./message"

/** `dashboardSortAtom`'s key: the default sort for a URL without `?sort`. */
const SORT_KEY = "maple.dashboards.sort"
const decodeStoredSort = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))

export const ReadClock = Command.define("ReadDashboardsListClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

/** A picked tag keeps focus in the filter's search, as Base UI's items do. */
export const FocusTagSearch = Command.define("FocusDashboardsTagSearch", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocusTagSearch],
	execute: ({ id }) =>
		Dom.focus(`#${CSS.escape(id)}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocusTagSearch())),
})

/** `useDashboardPreferences`' first read of both localStorage entries. */
export const LoadPreferences = Command.define("LoadDashboardsPreferences", {
	messages: [Message.CompletedLoadPreferences],
	execute: Effect.sync(() =>
		Message.CompletedLoadPreferences({
			favorites: readDashboardFavorites(),
			sort: Option.getOrElse(
				Option.flatMap(readLocalStorage(SORT_KEY), decodeStoredSort),
				() => "updated",
			),
		}),
	),
})

/** The atoms' writes; the favorites event lets the shell's Pinned group follow. */
export const SavePreferences = Command.define("SaveDashboardsPreferences", {
	args: { favorites: Schema.NullOr(Schema.Array(Schema.String)), sort: Schema.NullOr(Schema.String) },
	messages: [Message.CompletedSavePreferences],
	execute: ({ favorites, sort }) =>
		Effect.sync(() => {
			if (favorites !== null) {
				writeLocalStorage(DASHBOARD_FAVORITES_KEY, JSON.stringify(favorites))
				window.dispatchEvent(new Event(DASHBOARD_FAVORITES_EVENT))
			}
			if (sort !== null) writeLocalStorage(SORT_KEY, JSON.stringify(sort))
			return Message.CompletedSavePreferences()
		}),
})

/** `importInputRef.current?.click()`: opens the browser's file chooser. */
export const OpenImportPicker = Command.define("OpenDashboardImportPicker", {
	messages: [Message.CompletedOpenImportPicker],
	execute: Effect.sync(() => {
		window.document.getElementById("dashboards-import-input")?.click()
		return Message.CompletedOpenImportPicker()
	}),
})

export const WaitSearchDebounce = Command.define("WaitDashboardsSearchDebounce", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ generation }) =>
		Effect.as(Effect.sleep(Duration.millis(300)), Message.ElapsedSearchDebounce({ generation })),
})

/** `importDashboard`: create, then wait for the txid on the shape stream; the new id. */
const createFromPortable = (orgId: string, portable: PortableDashboard) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const created = yield* client.dashboards.create({ payload: createPayload(portable) })
		yield* awaitTxid(orgId, created.txid)
		return { id: created.id, name: created.name, isPerses: false }
	})

const toResult = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.result(Effect.mapError(effect, (error) => errorMessageOf(error)))

/** `createDashboard("Untitled Dashboard")`. */
export const CreateDashboard = Command.define("CreateDashboard", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedCreateDashboard],
	execute: ({ orgId }) =>
		Effect.map(
			toResult(
				createFromPortable(orgId, {
					name: "Untitled Dashboard",
					timeRange: { type: "relative", value: "12h" },
					widgets: [],
				}),
			),
			(result) =>
				Message.CompletedCreateDashboard({ result: Result.map(result, (created) => created.id) }),
		),
})

/** `handleDuplicate`: the dashboard's portable form re-imported as "<name> copy". */
export const DuplicateDashboard = Command.define("DuplicateDashboard", {
	args: { orgId: Schema.String, id: Schema.String },
	messages: [Message.CompletedDuplicateDashboard],
	execute: ({ orgId, id }) =>
		Effect.map(
			toResult(
				Effect.flatMap(readDocument(orgId, id), (document) =>
					createFromPortable(orgId, { ...toPortable(document), name: `${document.name} copy` }),
				),
			),
			(result) => Message.CompletedDuplicateDashboard({ result }),
		),
})

export const ExportDashboard = Command.define("ExportDashboard", {
	args: { orgId: Schema.String, id: Schema.String },
	messages: [Message.CompletedExportDashboard],
	execute: ({ orgId, id }) =>
		readDocument(orgId, id).pipe(
			Effect.flatMap(downloadPortable),
			Effect.ignore,
			Effect.as(Message.CompletedExportDashboard()),
		),
})

/** `handleImport`: a Perses dashboard goes to `importPerses`, anything else must be portable. */
export const ImportDashboard = Command.define("ImportDashboard", {
	args: { orgId: Schema.String, file: FoldkitFile },
	messages: [Message.CompletedImportDashboard],
	execute: ({ orgId, file }) =>
		Effect.map(
			toResult(
				Effect.gen(function* () {
					const raw = yield* Effect.tryPromise(() => file.text())
					const parsed: unknown = yield* Effect.try(() => JSON.parse(raw))
					if (isPersesDashboardJson(parsed)) {
						const client = yield* MapleApiV2Client
						const imported = yield* client.dashboards.importPerses({
							payload: { dashboard: parsed },
						})
						yield* awaitTxid(orgId, imported.dashboard.txid)
						return { id: imported.dashboard.id, name: imported.dashboard.name, isPerses: true }
					}
					return yield* createFromPortable(orgId, yield* parsePortable(parsed))
				}),
			),
			(result) => Message.CompletedImportDashboard({ result }),
		),
})

export const DeleteDashboard = Command.define("DeleteDashboard", {
	args: { orgId: Schema.String, id: Schema.String },
	messages: [Message.CompletedDeleteDashboard],
	execute: ({ orgId, id }) =>
		Effect.map(toResult(deleteDashboard(orgId, id)), (result) =>
			Message.CompletedDeleteDashboard({ result }),
		),
})

/** `onSaveTags` → `updateDashboard(id, { tags })`. */
export const SaveTags = Command.define("SaveDashboardTags", {
	args: { orgId: Schema.String, id: Schema.String, tags: Schema.Array(Schema.String) },
	messages: [Message.CompletedSaveTags],
	execute: ({ orgId, id, tags }) =>
		Effect.map(
			toResult(
				mutateDashboard(orgId, id, (document, nowIso) => ({ ...document, tags, updatedAt: nowIso })),
			),
			(result) => Message.CompletedSaveTags({ result }),
		),
})
