import { Option } from "effect"
import * as Keyed from "../../data/keyed"
import { requestKey } from "../../data/request-key"
import type { PageContext, PageReturn } from "../contract"
import { type CloudflareCardModel, LoadCloudflareUsage, PrimeCloudflare } from "./cloudflare"
import type { Message } from "./message"
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
		(next) => requestStatus(next, context, "cloudflare", "Refresh"),
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

/** A new attempt primes again (`primedRef.current = false` in `start`). */
export const resetPrime = (model: Model): Model => withCard(model, { isPrimed: false })
