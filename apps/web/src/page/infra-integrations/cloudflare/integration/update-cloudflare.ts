import type { CloudflareIntegrationStatus } from "@maple/domain/http"
import { Option, Array as Arr, String as Str } from "effect"
import { AsyncData, Command } from "foldkit"
import { ChartRuntime, LoadChartRuntime } from "@maple/views/charts/chart-runtime"
import * as Dialog from "@maple/views/ui/dialog"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import { HubRequest, type ProviderEnv, type ProviderReturn } from "../../../integrations/provider"
import { ingestPhaseOf } from "../ingest"
import {
	type CloudflareCardModel,
	CloudflareMessage,
	LoadCloudflareUsage,
	PrimeCloudflare,
	SaveCloudflareZones,
	type ZoneChoice,
	type ZoneSortKey,
} from "./cloudflare"
import { changedZoneChoices, zoneChoicesOf } from "./cloudflare-derive"
import { successOf } from "../../kit/success-of"

// The Cloudflare card's state changes, as the Cloudflare module's update.

type Env = ProviderEnv<CloudflareIntegrationStatus>
type Return = ProviderReturn<CloudflareCardModel, CloudflareMessage>

const withCard = (model: CloudflareCardModel, card: Partial<CloudflareCardModel>): CloudflareCardModel => ({
	...model,
	...card,
})

/** Both answers concatenated: the second step's model, every request and Command in order. */
const then = (first: Return, second: (model: CloudflareCardModel) => Return): Return => {
	const next = second(first.model)
	return {
		model: next.model,
		requests: [...(first.requests ?? []), ...(next.requests ?? [])],
		commands: [...(first.commands ?? []), ...(next.commands ?? [])],
	}
}

export const requestUsage = (model: CloudflareCardModel, env: Env, mode: Keyed.RequestMode): Return => {
	const key = requestKey(env.context.orgId, "integrations.cloudflareUsage", {})
	return Option.match(Keyed.request(model.usage, key, mode), {
		onNone: () => ({ model }),
		onSome: (usage) => ({ model: withCard(model, { usage }), commands: [LoadCloudflareUsage({ key })] }),
	})
}

/** The status and the usage, re-read together. */
export const refreshCloudflare = (model: CloudflareCardModel, env: Env): Return =>
	then({ model, requests: [HubRequest.readStatus("Supersede")] }, (next) =>
		requestUsage(next, env, "Refresh"),
	)

/** Once per attempt, unless the last prime found no grant yet. */
export const prime = (model: CloudflareCardModel): Return =>
	model.isPrimed || model.isPriming
		? { model }
		: { model: withCard(model, { isPrimed: true, isPriming: true }), commands: [PrimeCloudflare()] }

const completedPrime = (model: CloudflareCardModel, env: Env, isOk: boolean, isConnected: boolean): Return =>
	refreshCloudflare(withCard(model, { isPriming: false, isPrimed: isOk && isConnected }), env)

/** The card's entry: the usage read and the chart runtime its sparklines draw with. */
export const enterCloudflare = (model: CloudflareCardModel, env: Env): Return => {
	const usage = requestUsage(model, env, "Load")
	return model.chartRuntime._tag === "Ready"
		? usage
		: {
				...usage,
				commands: [
					...(usage.commands ?? []),
					Command.mapMessage(LoadChartRuntime(), (message) =>
						message._tag === "CompletedLoadChartRuntime"
							? CloudflareMessage.CompletedLoadChartRuntime()
							: CloudflareMessage.FailedLoadChartRuntime({ reason: message.reason }),
					),
				],
			}
}

/** A fresh connection still discovering or collecting: its status and usage are re-read. */
export const isSettling = (model: CloudflareCardModel, env: Pick<Env, "status" | "nowMs">): boolean => {
	const status = Option.getOrNull(AsyncData.getData(env.status.data))
	const usageData = model.usage.data
	const usage = AsyncData.isSuccess(usageData) || AsyncData.isRefreshing(usageData) ? usageData.data : null
	const phase = ingestPhaseOf(status, usage, env.nowMs)
	return phase !== null && phase.kind !== "live"
}

const gotZoneFilter = (model: CloudflareCardModel, message: ToggleGroup.Message): Return => {
	const next = ToggleGroup.update(model.zoneFilter, message)
	return {
		// Unpressing the active chip falls back to "All".
		model: withCard(model, {
			zoneFilter: next.model.values.length === 0 ? { ...next.model, values: ["all"] } : next.model,
		}),
		commands: Command.mapMessages(next.commands ?? [], (inner) =>
			CloudflareMessage.GotZoneFilterMessage({ message: inner }),
		),
	}
}

/** The active column flips; a new one starts high-to-low for traffic, else low-to-high. */
const clickedZoneSort = (model: CloudflareCardModel, key: ZoneSortKey): Return => {
	const sort = model.zoneSort
	return {
		model: withCard(model, {
			zoneSort:
				key === sort.key
					? { key, dir: sort.dir === "asc" ? "desc" : "asc" }
					: { key, dir: key === "requests" ? "desc" : "asc" },
		}),
	}
}

/** A new attempt primes again. */
export const resetPrime = (model: CloudflareCardModel): Return => ({
	model: withCard(model, { isPrimed: false }),
})

const storedZoneChoices = (env: Env): ReadonlyArray<ZoneChoice> => {
	const value = successOf(env.status.data)
	return value === null ? [] : zoneChoicesOf(value)
}

const zoneDialogStep = (model: CloudflareCardModel, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { zoneDialog: step.model }),
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		CloudflareMessage.GotZoneDialogMessage({ message }),
	),
})

/** Opening starts the draft from what is stored, so a dismissed edit leaves nothing behind. */
const clickedManageZones = (model: CloudflareCardModel, env: Env): Return =>
	zoneDialogStep(
		withCard(model, { zoneDraft: storedZoneChoices(env), zoneDraftSearch: "", zoneSaveError: null }),
		Dialog.open(model.zoneDialog),
	)

const updateDraftAccount = (
	model: CloudflareCardModel,
	accountId: string,
	edit: (account: ZoneChoice) => ZoneChoice,
): Return => ({
	model: withCard(model, {
		zoneDraft: Arr.map(model.zoneDraft, (account) =>
			account.accountId === accountId ? edit(account) : account,
		),
	}),
})

const toggledManagedZone = (model: CloudflareCardModel, accountId: string, zoneId: string): Return =>
	updateDraftAccount(model, accountId, (account) => ({
		...account,
		zones: Arr.map(account.zones, (zone) =>
			zone.id === zoneId ? { ...zone, watched: !zone.watched } : zone,
		),
	}))

/** Applies to the zones the name filter shows, so "Select none" then a search picks a few. */
const clickedSetAccountZones = (model: CloudflareCardModel, accountId: string, watched: boolean): Return => {
	const query = Str.toLowerCase(Str.trim(model.zoneDraftSearch))
	return updateDraftAccount(model, accountId, (account) => ({
		...account,
		zones: Arr.map(account.zones, (zone) =>
			query === "" || Str.includes(query)(Str.toLowerCase(zone.name)) ? { ...zone, watched } : zone,
		),
	}))
}

const submittedZoneSettings = (model: CloudflareCardModel, env: Env): Return => {
	if (model.isSavingZones) return { model }
	const changed = changedZoneChoices(storedZoneChoices(env), model.zoneDraft)
	if (changed.length === 0) return zoneDialogStep(model, Dialog.close(model.zoneDialog))
	return {
		model: withCard(model, { isSavingZones: true, zoneSaveError: null }),
		commands: [SaveCloudflareZones({ accounts: changed })],
	}
}

/**
 * Success closes the dialog; a failure keeps the draft open with its error. Both re-read the
 * status, since an earlier account of the save may have landed.
 */
const completedZoneSettings = (model: CloudflareCardModel, env: Env, failure: LoadFailure | null): Return => {
	const settled = withCard(model, { isSavingZones: false })
	if (failure !== null)
		return {
			model: withCard(settled, { zoneSaveError: failure.message }),
			requests: [HubRequest.readStatus("Supersede")],
		}
	return then(zoneDialogStep(settled, Dialog.close(settled.zoneDialog)), (next) =>
		refreshCloudflare(next, env),
	)
}

export const update = (model: CloudflareCardModel, message: CloudflareMessage, env: Env): Return =>
	CloudflareMessage.match<Return>(message, {
		CompletedLoadUsage: ({ key, result }) => ({
			model: withCard(model, { usage: Keyed.accept(model.usage, key, result) }),
		}),
		CompletedPrime: ({ isOk, isConnected }) => completedPrime(model, env, isOk, isConnected),
		// The ingest phase (stalled, backfill) follows the clock, so each tick rereads it.
		TickedIngest: () =>
			then(refreshCloudflare(model, env), (next) => ({
				model: next,
				requests: [HubRequest.readClock()],
			})),
		GotZoneFilterMessage: ({ message: child }) => gotZoneFilter(model, child),
		ChangedZoneSearch: ({ value }) => ({ model: withCard(model, { zoneSearch: value }) }),
		ClickedZoneSort: ({ key }) => clickedZoneSort(model, key),
		ClickedWorkersExpand: () => ({ model: withCard(model, { workersExpanded: !model.workersExpanded }) }),
		ClickedManageZones: () => clickedManageZones(model, env),
		GotZoneDialogMessage: ({ message: child }) =>
			zoneDialogStep(model, Dialog.update(model.zoneDialog, child)),
		ToggledManagedZone: ({ accountId, zoneId }) => toggledManagedZone(model, accountId, zoneId),
		ToggledWatchNewZones: ({ accountId }) =>
			updateDraftAccount(model, accountId, (account) => ({
				...account,
				watchNewZones: !account.watchNewZones,
			})),
		ClickedSetAccountZones: ({ accountId, watched }) => clickedSetAccountZones(model, accountId, watched),
		ChangedManagedZoneSearch: ({ value }) => ({ model: withCard(model, { zoneDraftSearch: value }) }),
		SubmittedZoneSettings: () => submittedZoneSettings(model, env),
		CompletedZones: ({ failure }) => completedZoneSettings(model, env, failure),
		CompletedLoadChartRuntime: () => ({ model: withCard(model, { chartRuntime: ChartRuntime.Ready() }) }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: withCard(model, { chartRuntime: ChartRuntime.Failed({ reason }) }),
		}),
		GotSparklineMessage: () => ({ model }),
	})
