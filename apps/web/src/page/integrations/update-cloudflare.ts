import { Option } from "effect"
import { Command } from "foldkit"
import { LoadChartRuntime } from "../../charts/chart-runtime"
import * as ToggleGroup from "../../ui/toggle-group"
import * as Keyed from "../../data/keyed"
import { requestKey } from "../../data/request-key"
import type { PageContext, PageReturn } from "../contract"
import {
	type CloudflareCardModel,
	LoadCloudflareUsage,
	PrimeCloudflare,
	type ZoneSortKey,
} from "./cloudflare"
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
