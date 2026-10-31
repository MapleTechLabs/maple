import {
	CloudflareUsageResponse,
	CloudflareZoneSettingsRequest,
	CloudflareZoneWatchSetting,
} from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { ChartRuntime } from "../../charts/chart-runtime"
import * as Dialog from "../../ui/dialog"
import * as ToggleGroup from "../../ui/toggle-group"
import { KeyedSchema } from "../../data/keyed"
import { LoadFailure, toLoadFailure } from "../../data/load-failure"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { Message } from "./message"

// `CloudflareAccountCard` and the Cloudflare half of `IntegrationConnectProvider`: state and reads.

export const ZoneSortKey = Schema.Literals(["name", "status", "requests"])
export type ZoneSortKey = typeof ZoneSortKey.Type

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
	/** `retainedInternalQuery("integrations", "cloudflareUsage")`. */
	usage: KeyedSchema(CloudflareUsageResponse, LoadFailure),
	/** Whether this attempt's prime already ran against a live grant (`primedRef`). */
	isPrimed: Schema.Boolean,
	isPriming: Schema.Boolean,
	/** `CloudflareZoneBoard`: name search, status chips (single-select), sort. */
	zoneSearch: Schema.String,
	zoneFilter: ToggleGroup.Model,
	zoneSort: Schema.Struct({ key: ZoneSortKey, dir: Schema.Literals(["asc", "desc"]) }),
	/** `CloudflareWorkersCard`'s "View all". */
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
	messages: [Message.CompletedLoadCloudflareUsage],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.integrations.cloudflareUsage()
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedLoadCloudflareUsage({ key, result })),
		),
})

/** `cloudflarePrime`: discovery and a first poll now instead of on the next cron tick. */
export const PrimeCloudflare = Command.define("PrimeCloudflare", {
	messages: [Message.CompletedCloudflarePrime],
	execute: Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		return yield* client.integrations.cloudflarePrime()
	}).pipe(
		Effect.match({
			onFailure: () => Message.CompletedCloudflarePrime({ isConnected: false, isOk: false }),
			onSuccess: (response) =>
				Message.CompletedCloudflarePrime({ isConnected: response.connected, isOk: true }),
		}),
	),
})

/** `cloudflareZoneSettings`, one PUT per changed account, in order; the first failure stops the rest. */
export const SaveCloudflareZones = Command.define("SaveCloudflareZones", {
	args: { accounts: Schema.Array(ZoneChoice) },
	messages: [Message.CompletedCloudflareZones],
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
							zones: account.zones.map(
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
				onFailure: (error) => Message.CompletedCloudflareZones({ failure: toLoadFailure(error) }),
				onSuccess: () => Message.CompletedCloudflareZones({ failure: null }),
			}),
		),
})
