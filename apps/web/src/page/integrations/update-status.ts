import { Option } from "effect"
import type { Command } from "foldkit"
import * as Keyed from "../../data/keyed"
import { requestKey } from "../../data/request-key"
import type { Resources } from "../../platform/resources"
import type { PageContext, PageReturn } from "../contract"
import {
	LoadChat,
	LoadCloudflare,
	LoadGcp,
	LoadGithub,
	LoadHazel,
	LoadPlanetscale,
	LoadPlanetscaleDatabases,
	LoadRailway,
	LoadScrapeTargets,
	LoadVercel,
} from "./command"
import type { Message } from "./message"
import type { Model, Statuses } from "./model"

// The shared status reads: keys, requests, and step chaining.

type Return = PageReturn<Model, Message>
type AnyCommand = Command.Command<Message, never, Resources>

const OPERATIONS = {
	cloudflare: "integrations.cloudflareStatus",
	railway: "integrations.railwayStatus",
	vercel: "integrations.vercelStatus",
	planetscale: "planetscaleIntegration.status",
	planetscaleDatabases: "planetscaleIntegration.databases",
	gcp: "gcpIntegration.status",
	hazel: "integrations.hazelStatus",
	github: "integrations.githubStatus",
	chat: "chatIntegration.connectors",
	scrapeTargets: "scrapeTargets.list",
} satisfies { readonly [K in keyof Statuses]: string }

export const statusKey = (context: PageContext, name: keyof Statuses) =>
	requestKey(context.orgId, OPERATIONS[name], {})

/**
 * `Refresh` is a write's `reactivityKeys`: it asks again even while a read is in flight, since that
 * read may predate the write. `Poll` is a timer's refresh and joins a read in flight.
 */
export type StatusMode = Keyed.RequestMode | "Poll"

const step = <A, E>(
	model: Model,
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: StatusMode,
	set: (statuses: Statuses, next: Keyed.Keyed<A, E>) => Statuses,
	command: () => AnyCommand,
): Return =>
	Option.match(Keyed.request(slot, key, mode === "Load" ? "Load" : "Refresh"), {
		onNone: () => (mode === "Refresh" ? { model, commands: [command()] } : { model }),
		onSome: (next) => ({
			model: { ...model, statuses: set(model.statuses, next) },
			commands: [command()],
		}),
	})

/** Requests one status read; a write's `reactivityKeys` refresh it with `Refresh`. */
export const requestStatus = (
	model: Model,
	context: PageContext,
	name: keyof Statuses,
	mode: StatusMode,
): Return => {
	const key = statusKey(context, name)
	const refresh = mode !== "Load"
	const s = model.statuses
	const go = <A, E>(
		slot: Keyed.Keyed<A, E>,
		set: (all: Statuses, next: Keyed.Keyed<A, E>) => Statuses,
		command: () => AnyCommand,
	) => step(model, slot, key, mode, set, command)
	switch (name) {
		case "cloudflare":
			return go(
				s.cloudflare,
				(all, cloudflare) => ({ ...all, cloudflare }),
				() => LoadCloudflare({ key, refresh }),
			)
		case "railway":
			return go(
				s.railway,
				(all, railway) => ({ ...all, railway }),
				() => LoadRailway({ key, refresh }),
			)
		case "vercel":
			return go(
				s.vercel,
				(all, vercel) => ({ ...all, vercel }),
				() => LoadVercel({ key }),
			)
		case "planetscale":
			return go(
				s.planetscale,
				(all, planetscale) => ({ ...all, planetscale }),
				() => LoadPlanetscale({ key, refresh }),
			)
		case "planetscaleDatabases":
			return go(
				s.planetscaleDatabases,
				(all, planetscaleDatabases) => ({ ...all, planetscaleDatabases }),
				() => LoadPlanetscaleDatabases({ key }),
			)
		case "gcp":
			return go(
				s.gcp,
				(all, gcp) => ({ ...all, gcp }),
				() => LoadGcp({ key, refresh }),
			)
		case "hazel":
			return go(
				s.hazel,
				(all, hazel) => ({ ...all, hazel }),
				() => LoadHazel({ key }),
			)
		case "github":
			return go(
				s.github,
				(all, github) => ({ ...all, github }),
				() => LoadGithub({ key }),
			)
		case "chat":
			return go(
				s.chat,
				(all, chat) => ({ ...all, chat }),
				() => LoadChat({ key }),
			)
		case "scrapeTargets":
			return go(
				s.scrapeTargets,
				(all, scrapeTargets) => ({ ...all, scrapeTargets }),
				() => LoadScrapeTargets({ key }),
			)
	}
}

/** Runs steps in order, threading the Model and collecting their Commands and last OutMessage. */
export const chain = (model: Model, steps: ReadonlyArray<(model: Model) => Return>): Return =>
	steps.reduce<Return>(
		(acc, next) => {
			const result = next(acc.model)
			return {
				model: result.model,
				commands: [...(acc.commands ?? []), ...(result.commands ?? [])],
				outMessage: result.outMessage ?? acc.outMessage,
			}
		},
		{ model },
	)

export const STATUS_NAMES: ReadonlyArray<keyof Statuses> = [
	"cloudflare",
	"railway",
	"vercel",
	"planetscale",
	"planetscaleDatabases",
	"gcp",
	"hazel",
	"github",
	"chat",
	"scrapeTargets",
]
