import type { V2AuditLogEntry } from "@maple/domain/http/v2"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { Array as Arr, Effect, Option, Record as Rec, Result, Schema, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as AuditModel from "../page/settings/audit-log/model"
import * as AuditUpdate from "../page/settings/audit-log/update"
import * as AuditView from "../page/settings/audit-log/view"
import type { Resources } from "../platform/resources"
import { SettingsSearch } from "../route/search"
import { AUDIT_ENTRIES, AUDIT_MEMBERS, AUDIT_NOW } from "./audit-log-fixture"
import { keepLocal } from "./local-commands"

// `/lab/audit-log`: the audit log tab over fixtures. Filters, the kind switch and the lookup all
// work: a navigation re-reads the fixtures through the page's own request. `?state=` picks a start.

export const LabState = Schema.Literals([
	"changes",
	"access",
	"all",
	"filtered",
	"expanded",
	"lookup-unknown",
	"empty",
	"error",
	"loading",
])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "changes",
	),
}))

type Search = typeof SettingsSearch.Type

export const Model = Schema.Struct({ state: LabState, search: SettingsSearch, audit: AuditModel.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotAuditMessage: { message: AuditModel.Message } })
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>
type AuditCommand = Command.Command<AuditModel.Message, never, Resources>

const TIME_ZONE = "Europe/Berlin"
const ACCESS_SUFFIXES = [".read", ".called", ".sql_executed", ".request"]
const isAccess = (action: string) => Arr.some(ACCESS_SUFFIXES, (suffix) => Str.endsWith(suffix)(action))

/** The fixtures the API would answer `request` with. */
const matching = (request: AuditModel.PageRequest): ReadonlyArray<V2AuditLogEntry> =>
	Arr.filter(
		AUDIT_ENTRIES,
		(entry) =>
			(request.kind !== "changes" || !isAccess(entry.action) || entry.outcome === "denied") &&
			(request.kind !== "access" || isAccess(entry.action)) &&
			(request.actorType === undefined || entry.actor_type === request.actorType) &&
			(request.actorId === undefined || entry.actor_id === request.actorId) &&
			(request.outcome === undefined || entry.outcome === request.outcome) &&
			(request.resourceType === undefined || entry.resource_type === request.resourceType) &&
			(request.action === undefined || entry.action === request.action) &&
			(request.resourceId === undefined || entry.resource_id === request.resourceId) &&
			(request.affectedUserId === undefined || entry.affected_user === request.affectedUserId) &&
			(request.requestId === undefined || entry.request_id === request.requestId),
	)

const searchFor = (state: LabState): Search => {
	switch (state) {
		case "access":
			return { tab: "audit-log", kind: "access" }
		case "all":
			return { tab: "audit-log", kind: "all" }
		case "filtered":
			return { tab: "audit-log", kind: "all", actor: AUDIT_MEMBERS[1].value, resource_type: "api_key" }
		default:
			return { tab: "audit-log" }
	}
}

const decodeSearch = Schema.decodeUnknownOption(SettingsSearch)

/** The search a page navigation lands on, read off its URL. */
const searchOfUrl = (url: string): Search =>
	Option.getOrElse(
		decodeSearch(Rec.fromEntries([...new URL(url, "https://lab.local").searchParams.entries()])),
		(): Search => ({ tab: "audit-log" }),
	)

/** Answers a page read the step asked for from the fixtures, as the API would. */
const answer = (state: LabState, model: AuditModel.Model, commands: ReadonlyArray<AuditCommand>) => {
	if (state === "loading" || !Arr.some(commands, (command) => command.name === "FetchAuditLogPage"))
		return model
	const result =
		state === "error"
			? Result.fail(toLoadFailure("The warehouse did not answer in time"))
			: Result.succeed({
					data: state === "empty" ? [] : matching(model.request),
					has_more: false,
					next_cursor: null,
				})
	return AuditUpdate.update(
		model,
		AuditModel.Message.CompletedFetchPage({ request: model.request, resolvedSince: null, result }),
		{},
	).model
}

/** The kit's own commands and the custom range's clock read; every API read is answered above. */
const local = (commands: ReadonlyArray<AuditCommand> | undefined) => [
	...keepLocal(commands),
	...Arr.filter(commands ?? [], (command) => command.name === "ResolveAuditCustomToday"),
]

const lift = (commands: ReadonlyArray<AuditCommand>) =>
	Command.mapMessages(commands, (message) => Message.GotAuditMessage({ message }))

export const init = (flags: Flags): Return => {
	const search = searchFor(flags.state)
	const entered = AuditUpdate.init(search)
	const withMembers = AuditUpdate.update(
		answer(flags.state, entered.model, entered.commands ?? []),
		AuditModel.Message.CompletedFetchMembers({ members: AUDIT_MEMBERS }),
		search,
	).model
	const extra: ReadonlyArray<AuditModel.Message> =
		flags.state === "expanded"
			? [AuditModel.Message.ToggledEntry({ id: AUDIT_ENTRIES[2]?.id ?? "" })]
			: flags.state === "lookup-unknown"
				? [
						AuditModel.Message.ChangedLookup({ value: "checkout" }),
						AuditModel.Message.SubmittedLookup(),
					]
				: []
	const audit = Arr.reduce(
		extra,
		withMembers,
		(model, message) => AuditUpdate.update(model, message, search).model,
	)
	return { model: { state: flags.state, search, audit } }
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotAuditMessage: ({ message: child }) => {
			const step = AuditUpdate.update(model.audit, child, model.search)
			const out = step.outMessage
			if (out?._tag !== "RequestedNavigation")
				return {
					model: { ...model, audit: answer(model.state, step.model, step.commands ?? []) },
					commands: lift(local(step.commands)),
				}
			const search = searchOfUrl(out.url)
			const moved = AuditUpdate.searchChanged(step.model, search)
			return {
				model: { ...model, search, audit: answer(model.state, moved.model, moved.commands ?? []) },
				commands: lift([...local(step.commands), ...local(moved.commands)]),
			}
		},
	})

export const breadcrumbs = [{ label: "Lab", href: "/lab" }, { label: "Audit log" }] as const

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("mx-auto w-full max-w-5xl p-6")],
		[
			h.submodel({
				slotId: "lab-audit-log",
				model: model.audit,
				view: AuditView.view,
				viewInputs: { search: model.search, nowMs: AUDIT_NOW, timeZone: TIME_ZONE, apiKeys: [] },
				toParentMessage: (message: AuditModel.Message) => Message.GotAuditMessage({ message }),
			}),
		],
	)
