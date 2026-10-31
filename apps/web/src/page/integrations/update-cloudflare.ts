import { Option } from "effect"
import { AsyncData, Command } from "foldkit"
import { LoadChartRuntime } from "../../charts/chart-runtime"
import * as Dialog from "../../ui/dialog"
import * as ToggleGroup from "../../ui/toggle-group"
import * as Keyed from "../../data/keyed"
import type { LoadFailure } from "../../data/load-failure"
import { requestKey } from "../../data/request-key"
import type { PageContext, PageReturn } from "../contract"
import {
	type CloudflareCardModel,
	LoadCloudflareUsage,
	PrimeCloudflare,
	SaveCloudflareZones,
	type ZoneChoice,
	type ZoneSortKey,
} from "./cloudflare"
import { changedZoneChoices, zoneChoicesOf } from "./cloudflare-derive"
import { Message } from "./message"
import type { Model } from "./model"
import { chain, requestStatus } from "./update-status"

// The Cloudflare card's reads and the connect flow's prime (`CloudflareConnectBoundary`).

type Return = PageReturn<Model, Message>

const withCard = (model: Model, card: Partial<CloudflareCardModel>): Model => ({
	...model,
	cloudflareCard: { ...model.cloudflareCard, ...card },
})

export const requestUsage = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const key = requestKey(context.orgId, "integrations.cloudflareUsage", {})
	return Option.match(Keyed.request(model.cloudflareCard.usage, key, mode), {
		onNone: () => ({ model }),
		onSome: (usage) => ({ model: withCard(model, { usage }), commands: [LoadCloudflareUsage({ key })] }),
	})
}

/** `refreshStatus()` + `refreshUsage()`. */
export const refreshCloudflare = (model: Model, context: PageContext): Return =>
	chain(model, [
		(next) => requestStatus(next, context, "cloudflare", "Supersede"),
		(next) => requestUsage(next, context, "Refresh"),
	])

/** `primeIntegration`: once per attempt, unless the last prime found no grant yet. */
export const prime = (model: Model): Return =>
	model.cloudflareCard.isPrimed || model.cloudflareCard.isPriming
		? { model }
		: { model: withCard(model, { isPrimed: true, isPriming: true }), commands: [PrimeCloudflare()] }

export const completedPrime = (
	model: Model,
	context: PageContext,
	isOk: boolean,
	isConnected: boolean,
): Return => refreshCloudflare(withCard(model, { isPriming: false, isPrimed: isOk && isConnected }), context)

/** The card's entry: the usage read and the chart runtime its sparklines draw with. */
export const enterCloudflare = (model: Model, context: PageContext): Return => {
	const usage = requestUsage(model, context, "Load")
	const loadsRuntime = model.cloudflareCard.chartRuntime._tag !== "Ready"
	return loadsRuntime
		? {
				...usage,
				commands: [
					...(usage.commands ?? []),
					Command.mapMessage(LoadChartRuntime(), (message) =>
						message._tag === "CompletedLoadChartRuntime"
							? Message.CompletedLoadChartRuntime()
							: Message.FailedLoadChartRuntime({ reason: message.reason }),
					),
				],
			}
		: usage
}

export const gotZoneFilter = (model: Model, message: ToggleGroup.Message): Return => {
	const next = ToggleGroup.update(model.cloudflareCard.zoneFilter, message)
	return {
		// Unpressing the active chip falls back to "All".
		model: withCard(model, {
			zoneFilter: next.model.values.length === 0 ? { ...next.model, values: ["all"] } : next.model,
		}),
		commands: Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotZoneFilterMessage({ message: inner }),
		),
	}
}

/** `handleSort`: the active column flips; a new one starts high-to-low for traffic, else low-to-high. */
export const clickedZoneSort = (model: Model, key: ZoneSortKey): Return => {
	const sort = model.cloudflareCard.zoneSort
	return {
		model: withCard(model, {
			zoneSort:
				key === sort.key
					? { key, dir: sort.dir === "asc" ? "desc" : "asc" }
					: { key, dir: key === "requests" ? "desc" : "asc" },
		}),
	}
}

export const updateBoard = (model: Model, card: Partial<CloudflareCardModel>): Return => ({
	model: withCard(model, card),
})

/** A new attempt primes again (`primedRef.current = false` in `start`). */
export const resetPrime = (model: Model): Model => withCard(model, { isPrimed: false })

const storedZoneChoices = (model: Model): ReadonlyArray<ZoneChoice> => {
	const data = model.statuses.cloudflare.data
	return AsyncData.isSuccess(data) || AsyncData.isRefreshing(data) ? zoneChoicesOf(data.data) : []
}

const zoneDialogStep = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { zoneDialog: step.model }),
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotZoneDialogMessage({ message }),
	),
})

/** Opening starts the draft from what is stored, so a dismissed edit leaves nothing behind. */
export const clickedManageZones = (model: Model): Return =>
	zoneDialogStep(
		withCard(model, {
			zoneDraft: storedZoneChoices(model),
			zoneDraftSearch: "",
			zoneSaveError: null,
		}),
		Dialog.open(model.cloudflareCard.zoneDialog),
	)

export const gotZoneDialog = (model: Model, message: Dialog.Message): Return =>
	zoneDialogStep(model, Dialog.update(model.cloudflareCard.zoneDialog, message))

const updateDraftAccount = (
	model: Model,
	accountId: string,
	edit: (account: ZoneChoice) => ZoneChoice,
): Return => ({
	model: withCard(model, {
		zoneDraft: model.cloudflareCard.zoneDraft.map((account) =>
			account.accountId === accountId ? edit(account) : account,
		),
	}),
})

export const toggledManagedZone = (model: Model, accountId: string, zoneId: string): Return =>
	updateDraftAccount(model, accountId, (account) => ({
		...account,
		zones: account.zones.map((zone) => (zone.id === zoneId ? { ...zone, watched: !zone.watched } : zone)),
	}))

export const toggledWatchNewZones = (model: Model, accountId: string): Return =>
	updateDraftAccount(model, accountId, (account) => ({ ...account, watchNewZones: !account.watchNewZones }))

/** Applies to the zones the name filter shows, so "Select none" then a search picks a few. */
export const clickedSetAccountZones = (model: Model, accountId: string, watched: boolean): Return => {
	const query = model.cloudflareCard.zoneDraftSearch.trim().toLowerCase()
	return updateDraftAccount(model, accountId, (account) => ({
		...account,
		zones: account.zones.map((zone) =>
			query === "" || zone.name.toLowerCase().includes(query) ? { ...zone, watched } : zone,
		),
	}))
}

export const submittedZoneSettings = (model: Model): Return => {
	const card = model.cloudflareCard
	if (card.isSavingZones) return { model }
	const changed = changedZoneChoices(storedZoneChoices(model), card.zoneDraft)
	if (changed.length === 0) return zoneDialogStep(model, Dialog.close(card.zoneDialog))
	return {
		model: withCard(model, { isSavingZones: true, zoneSaveError: null }),
		commands: [SaveCloudflareZones({ accounts: changed })],
	}
}

/**
 * Success closes the dialog; a failure keeps the draft open with its error. Both re-read the
 * status, since an earlier account of the save may have landed.
 */
export const completedZoneSettings = (
	model: Model,
	context: PageContext,
	failure: LoadFailure | null,
): Return => {
	const settled = withCard(model, { isSavingZones: false })
	if (failure !== null)
		return requestStatus(
			withCard(settled, { zoneSaveError: failure.message }),
			context,
			"cloudflare",
			"Supersede",
		)
	return chain(settled, [
		(next) => zoneDialogStep(next, Dialog.close(next.cloudflareCard.zoneDialog)),
		(next) => refreshCloudflare(next, context),
	])
}
