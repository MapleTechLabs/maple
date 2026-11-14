import {
	CloudflareUsageResponse,
	CloudflareZoneSettingsRequest,
	CloudflareZoneWatchSetting,
} from "@maple/domain/http"
import { Effect, Schema, Array as Arr } from "effect"
import { AsyncData, Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { ChartRuntimeMessages } from "@maple/views/charts/chart-env"
import * as Chart from "@maple/views/charts/chart"
import { ChartRuntime } from "@maple/views/charts/chart-runtime"
import * as Dialog from "@maple/views/ui/dialog"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure, toLoadFailure, settleTo } from "@maple/views/data/load-failure"
import { MapleInternalApiClient } from "../../../../platform/api-clients"
import { IntegrationStatuses } from "../../../../data/integration-statuses"

export const ZoneSortKey = Schema.Literals(["name", "status", "requests"])
export type ZoneSortKey = typeof ZoneSortKey.Type

/** The Cloudflare module's own messages; the hub carries them in `GotCloudflareMessage`. */
export const CloudflareMessage = defineMessageUnion({
	CompletedLoadUsage: { key: Schema.String, result: Schema.Result(CloudflareUsageResponse, LoadFailure) },
	CompletedPrime: { isConnected: Schema.Boolean, isOk: Schema.Boolean },
	/** Every 30 s while a fresh connection settles. */
	TickedIngest: {},
	GotZoneFilterMessage: { message: ToggleGroup.Message },
	ChangedZoneSearch: { value: Schema.String },
	ClickedZoneSort: { key: Schema.Literals(["name", "status", "requests"]) },
	ClickedWorkersExpand: {},
	ClickedManageZones: {},
	GotZoneDialogMessage: { message: Dialog.Message },
	ToggledManagedZone: { accountId: Schema.String, zoneId: Schema.String },
	ToggledWatchNewZones: { accountId: Schema.String },
	/** "Select all" / "Select none" over the account's zones the name filter shows. */
	ClickedSetAccountZones: { accountId: Schema.String, watched: Schema.Boolean },
	ChangedManagedZoneSearch: { value: Schema.String },
	SubmittedZoneSettings: {},
	CompletedZones: { failure: Schema.NullOr(LoadFailure) },
	...ChartRuntimeMessages,
	GotSparklineMessage: { message: Chart.Message },
})
export type CloudflareMessage = typeof CloudflareMessage.Type

/** The hub's status read for Cloudflare, shared with the sidebar. */
export const CLOUDFLARE_STATUS_READ = {
	name: "LoadIntegrationsCloudflareStatus",
	read: (refresh: boolean) =>
		Effect.flatMap(IntegrationStatuses, (statuses) => statuses.cloudflare({ refresh })),
}

/** One account's zone choice as the "Manage zones" dialog edits it. */
export const ZoneChoice = Schema.Struct({
	accountId: Schema.String,
	accountName: Schema.NullOr(Schema.String),
	watchNewZones: Schema.Boolean,
	zones: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, watched: Schema.Boolean })),
})
export type ZoneChoice = typeof ZoneChoice.Type

export const initCloudflareCard = () => ({
	usage: { key: null, data: AsyncData.Idle() },
	isPrimed: false,
	isPriming: false,
	zoneSearch: "",
	zoneFilter: ToggleGroup.init({ label: "Filter zones by status", values: ["all"] }),
	zoneSort: { key: "requests" as const, dir: "desc" as const },
	workersExpanded: false,
	chartRuntime: ChartRuntime.Loading(),
	zoneDialog: Dialog.init("cloudflare-zones", "dialog"),
	zoneDraft: [],
	zoneDraftSearch: "",
	isSavingZones: false,
	zoneSaveError: null,
})

export const CloudflareCardModel = Schema.Struct({
	usage: KeyedSchema(CloudflareUsageResponse, LoadFailure),
	/** Whether this attempt's prime already ran against a live grant. */
	isPrimed: Schema.Boolean,
	isPriming: Schema.Boolean,
	/** The zone board: name search, status chips (single-select), sort. */
	zoneSearch: Schema.String,
	zoneFilter: ToggleGroup.Model,
	zoneSort: Schema.Struct({ key: ZoneSortKey, dir: Schema.Literals(["asc", "desc"]) }),
	/** The Workers card's "View all". */
	workersExpanded: Schema.Boolean,
	chartRuntime: ChartRuntime,
	/** "Manage zones": the dialog, its per-account draft and name filter, and the save. */
	zoneDialog: Dialog.Model,
	zoneDraft: Schema.Array(ZoneChoice),
	zoneDraftSearch: Schema.String,
	isSavingZones: Schema.Boolean,
	zoneSaveError: Schema.NullOr(Schema.String),
})
export type CloudflareCardModel = typeof CloudflareCardModel.Type

export const LoadCloudflareUsage = Command.define("LoadIntegrationsCloudflareUsage", {
	args: { key: Schema.String },
	messages: [CloudflareMessage.CompletedLoadUsage],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.integrations.cloudflareUsage()
		}).pipe(settleTo((result) => CloudflareMessage.CompletedLoadUsage({ key, result }))),
})

/** `cloudflarePrime`: discovery and a first poll now instead of on the next cron tick. */
export const PrimeCloudflare = Command.define("PrimeCloudflare", {
	messages: [CloudflareMessage.CompletedPrime],
	execute: Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		return yield* client.integrations.cloudflarePrime()
	}).pipe(
		Effect.match({
			onFailure: () => CloudflareMessage.CompletedPrime({ isConnected: false, isOk: false }),
			onSuccess: (response) =>
				CloudflareMessage.CompletedPrime({ isConnected: response.connected, isOk: true }),
		}),
	),
})

/** `cloudflareZoneSettings`, one PUT per changed account, in order; the first failure stops the rest. */
export const SaveCloudflareZones = Command.define("SaveCloudflareZones", {
	args: { accounts: Schema.Array(ZoneChoice) },
	messages: [CloudflareMessage.CompletedZones],
	execute: ({ accounts }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			yield* Effect.forEach(
				accounts,
				(account) =>
					client.integrations.cloudflareZoneSettings({
						payload: new CloudflareZoneSettingsRequest({
							accountId: account.accountId,
							watchNewZones: account.watchNewZones,
							zones: Arr.map(
								account.zones,
								(zone) =>
									new CloudflareZoneWatchSetting({
										zoneId: zone.id,
										watched: zone.watched,
									}),
							),
						}),
					}),
				{ discard: true },
			)
		}).pipe(
			Effect.match({
				onFailure: (error) => CloudflareMessage.CompletedZones({ failure: toLoadFailure(error) }),
				onSuccess: () => CloudflareMessage.CompletedZones({ failure: null }),
			}),
		),
})
