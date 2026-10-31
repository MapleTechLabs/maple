import { Option } from "effect"
import type { Command } from "foldkit"
import * as Keyed from "../../data/keyed"
import { requestKey } from "../../data/request-key"
import type { Resources } from "../../platform/resources"
import type { PageContext, PageReturn } from "../contract"
import {
	LoadAws,
	LoadChat,
	LoadCloudflare,
	LoadGcp,
	LoadGithub,
	LoadLinear,
	LoadPlanetscale,
	LoadPlanetscaleDatabases,
	LoadRailway,
	LoadScrapeTargets,
	LoadSupabase,
} from "./command"
import type { Message } from "./message"
import type { Model, Statuses } from "./model"

// The shared status reads: keys, requests, and step chaining.

type Return = PageReturn<Model, Message>
type AnyCommand = Command.Command<Message, never, Resources>

const OPERATIONS = {
	cloudflare: "integrations.cloudflareStatus",
	railway: "integrations.railwayStatus",
	planetscale: "planetscaleIntegration.status",
	planetscaleDatabases: "planetscaleIntegration.databases",
	gcp: "gcpIntegration.status",
	aws: "awsIntegration.status",
	supabase: "integrations.supabaseStatus",
	linear: "integrations.linearStatus",
	github: "integrations.githubStatus",
	chat: "chatIntegration.connectors",
	scrapeTargets: "scrapeTargets.list",
} satisfies { readonly [K in keyof Statuses]: string }

export const statusKey = (context: PageContext, name: keyof Statuses) =>
	requestKey(context.orgId, OPERATIONS[name], {})

const step = <A, E>(
	model: Model,
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.ReadMode,
	set: (statuses: Statuses, next: Keyed.Keyed<A, E>) => Statuses,
	command: (slotKey: string) => AnyCommand,
): Return =>
	Option.match(Keyed.requestFor(slot, key, mode), {
		onNone: () => ({ model }),
		onSome: (requested) => ({
			model: { ...model, statuses: set(model.statuses, requested) },
			commands: [command(requested.key)],
		}),
	})

/** Requests one status read; a write's `reactivityKeys` re-read it with `Supersede`, a timer with `Refresh`. */
export const requestStatus = (
	model: Model,
	context: PageContext,
	name: keyof Statuses,
	mode: Keyed.ReadMode,
): Return => {
	const key = statusKey(context, name)
	const refresh = mode !== "Load"
	const s = model.statuses
	const go = <A, E>(
		slot: Keyed.Keyed<A, E>,
		set: (all: Statuses, next: Keyed.Keyed<A, E>) => Statuses,
		command: (slotKey: string) => AnyCommand,
	) => step(model, slot, key, mode, set, command)
	switch (name) {
		case "cloudflare":
			return go(
				s.cloudflare,
				(all, cloudflare) => ({ ...all, cloudflare }),
				(slotKey) => LoadCloudflare({ key: slotKey, refresh }),
			)
		case "railway":
			return go(
				s.railway,
				(all, railway) => ({ ...all, railway }),
				(slotKey) => LoadRailway({ key: slotKey, refresh }),
			)
		case "planetscale":
			return go(
				s.planetscale,
				(all, planetscale) => ({ ...all, planetscale }),
				(slotKey) => LoadPlanetscale({ key: slotKey, refresh }),
			)
		case "planetscaleDatabases":
			return go(
				s.planetscaleDatabases,
				(all, planetscaleDatabases) => ({ ...all, planetscaleDatabases }),
				(slotKey) => LoadPlanetscaleDatabases({ key: slotKey }),
			)
		case "gcp":
			return go(
				s.gcp,
				(all, gcp) => ({ ...all, gcp }),
				(slotKey) => LoadGcp({ key: slotKey, refresh }),
			)
		case "aws":
			return go(
				s.aws,
				(all, aws) => ({ ...all, aws }),
				(slotKey) => LoadAws({ key: slotKey }),
			)
		case "supabase":
			return go(
				s.supabase,
				(all, supabase) => ({ ...all, supabase }),
				(slotKey) => LoadSupabase({ key: slotKey, refresh }),
			)
		case "linear":
			return go(
				s.linear,
				(all, linear) => ({ ...all, linear }),
				(slotKey) => LoadLinear({ key: slotKey }),
			)
		case "github":
			return go(
				s.github,
				(all, github) => ({ ...all, github }),
				(slotKey) => LoadGithub({ key: slotKey }),
			)
		case "chat":
			return go(
				s.chat,
				(all, chat) => ({ ...all, chat }),
				(slotKey) => LoadChat({ key: slotKey }),
			)
		case "scrapeTargets":
			return go(
				s.scrapeTargets,
				(all, scrapeTargets) => ({ ...all, scrapeTargets }),
				(slotKey) => LoadScrapeTargets({ key: slotKey }),
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
	"planetscale",
	"planetscaleDatabases",
	"gcp",
	"aws",
	"supabase",
	"linear",
	"github",
	"chat",
	"scrapeTargets",
]
