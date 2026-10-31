import { Schema } from "effect"
import type * as Keyed from "../../data/keyed"
import { PageOutMessage, type PageContext, type PageReturn } from "../contract"
import { integrationOfSearch } from "./catalog"
import { ConnectProvider, type ConnectModel, PROVIDERS } from "./connect"
import type { Message } from "./message"
import type { Model, Statuses } from "./model"
import { chain, requestStatus } from "./update-status"
import { TrackConnected } from "./command"
import * as Cloudflare from "./update-cloudflare"
import * as Planetscale from "./update-planetscale"
import * as Supabase from "./update-supabase"

// The OAuth popup flow's state changes; the popup itself runs in `subscription.ts`.

type Return = PageReturn<Model, Message>

const STATUS_OF = {
	cloudflare: "cloudflare",
	linear: "linear",
	github: "github",
	planetscale: "planetscale",
	supabase: "supabase",
} satisfies { readonly [K in ConnectProvider]: keyof Statuses }

const withConnect = (model: Model, connect: Partial<ConnectModel>): Model => ({
	...model,
	connect: { ...model.connect, ...connect },
})

const toast = (model: Model, type: "success" | "error", title: string, description = ""): Return => ({
	model,
	outMessage: PageOutMessage.RequestedToast({ type, title, description }),
})

const isCurrent = (model: Model, attempt: number) => model.connect.active?.attempt === attempt

/** `refreshStatus` of the provider (Cloudflare's usage and prime ride along, see its card). */
export const refreshProvider = (
	model: Model,
	context: PageContext,
	provider: ConnectProvider,
	mode: Keyed.ReadMode = "Supersede",
): Return => requestStatus(model, context, STATUS_OF[provider], mode)

export const clickedConnect = (model: Model): Return => {
	const integration = integrationOfSearch(model.search.integration)
	if (!Schema.is(ConnectProvider)(integration) || model.connect.isStarting) return { model }
	if (integration === "linear" && !model.isAdmin) return { model }
	const attempt = model.connect.attempts + 1
	const base = integration === "cloudflare" ? Cloudflare.resetPrime(model) : model
	return {
		model: withConnect(base, {
			attempts: attempt,
			active: { provider: integration, attempt },
			isStarting: true,
			isClosed: false,
		}),
	}
}

/** The start mutation's `reactivityKeys` re-read the provider's status on success. */
export const succeededStart = (model: Model, context: PageContext, attempt: number): Return => {
	const active = model.connect.active
	return active !== null && active.attempt === attempt
		? chain(withConnect(model, { isStarting: false }), [
				(next) => refreshProvider(next, context, active.provider),
				// PlanetScale's start invalidates every `planetscaleIntegration` read, the inventory too.
				(next) =>
					active.provider === "planetscale"
						? requestStatus(next, context, "planetscaleDatabases", "Supersede")
						: { model: next },
			])
		: { model }
}

export const failedStart = (model: Model, attempt: number, title: string, description: string): Return =>
	isCurrent(model, attempt)
		? toast(withConnect(model, { isStarting: false, active: null }), "error", title, description)
		: { model }

export const blockedPopup = (model: Model, context: PageContext, attempt: number): Return => {
	const active = model.connect.active
	if (active === null || active.attempt !== attempt) return { model }
	const blocked = toast(
		withConnect(model, { isStarting: false, active: null }),
		"error",
		`Your browser blocked the ${PROVIDERS[active.provider].label} window`,
		"Allow pop-ups for this site, then try connecting again.",
	)
	return chain(model, [() => blocked, (next) => refreshProvider(next, context, active.provider)])
}

export const polled = (model: Model, context: PageContext, attempt: number): Return => {
	const active = model.connect.active
	return active !== null && active.attempt === attempt
		? refreshProvider(model, context, active.provider, "Refresh")
		: { model }
}

/** `onClosed`: re-read the status; a provider with a grace keeps the attempt open a while. */
export const closedPopup = (model: Model, context: PageContext, attempt: number): Return => {
	const active = model.connect.active
	if (active === null || active.attempt !== attempt) return { model }
	const hasGrace = PROVIDERS[active.provider].closeGraceMs > 0
	const next = hasGrace ? withConnect(model, { isClosed: true }) : withConnect(model, { active: null })
	return active.provider === "cloudflare"
		? chain(next, [(after) => Cloudflare.refreshCloudflare(after, context), Cloudflare.prime])
		: refreshProvider(next, context, active.provider)
}

export const endedGrace = (model: Model, attempt: number): Return =>
	isCurrent(model, attempt) ? { model: withConnect(model, { active: null, isClosed: false }) } : { model }

const CONNECTED_TITLE = {
	cloudflare: "Cloudflare account connected",
	linear: "Linear connected",
	github: "GitHub connected",
	planetscale: null,
	supabase: "Supabase connected",
} satisfies { readonly [K in ConnectProvider]: string | null }

/** `useIntegrationMessage`: the callback page's verdict; a success is `integration_connected`. */
export const receivedCallback = (
	model: Model,
	context: PageContext,
	provider: ConnectProvider,
	status: string,
	message: string | null,
): Return => {
	const label = PROVIDERS[provider].label
	if (status === "success") {
		const title = CONNECTED_TITLE[provider]
		return chain(provider === "planetscale" ? Planetscale.restartWatch(model) : model, [
			(next) => ({ model: next, commands: [TrackConnected({ provider })] }),
			(next) => (title === null ? { model: next } : toast(next, "success", title)),
			(next) =>
				provider === "cloudflare" ? Cloudflare.prime(next) : refreshProvider(next, context, provider),
			// The callback no longer discovers projects; a sync now lists them instead of the hourly cron.
			(next) => (provider === "supabase" ? Supabase.clickedSync(next) : { model: next }),
		])
	}
	if (status !== "error") return { model }
	const failed = toast(model, "error", message ?? `${label} connection failed`)
	return provider === "cloudflare"
		? chain(model, [() => failed, (next) => refreshProvider(next, context, provider)])
		: failed
}
