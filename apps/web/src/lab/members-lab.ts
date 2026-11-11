import * as Policy from "@maple/domain/policy"
import { Array as Arr, Effect, Option, Result, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as MembersModel from "../page/settings/members/model"
import * as MembersUpdate from "../page/settings/members/update"
import * as MembersView from "../page/settings/members/view"
import type { Resources } from "../platform/resources"
import { keepLocal } from "./local-commands"

// `/lab/members`: the settings members tab over fixtures, seen by an admin. `?state=` picks a start:
// the list, or a role change waiting on its inline confirm strip, or that change saving.

export const LabState = Schema.Literals(["list", "confirming", "saving"])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "confirming",
	),
}))

export const Model = Schema.Struct({ members: MembersModel.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotMembersMessage: { message: MembersModel.Message } })
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const NOW = Date.UTC(2026, 10, 11, 9, 0)
const DAY = 86_400_000
const TIME_ZONE = "Europe/Berlin"

const ROWS: ReadonlyArray<MembersModel.MemberRow> = [
	{
		id: "user_ada",
		name: "Ada Lovelace",
		identifier: "ada@acme.test",
		imageUrl: "",
		role: "org:admin",
		createdAtMs: NOW - 90 * DAY,
		isCurrentUser: true,
	},
	{
		id: "user_miguel",
		name: "Miguel Santos",
		identifier: "miguel@acme.test",
		imageUrl: "",
		role: "org:member",
		createdAtMs: NOW - 12 * DAY,
		isCurrentUser: false,
	},
	{
		id: "user_grace",
		name: "Grace Hopper",
		identifier: "grace@acme.test",
		imageUrl: "",
		role: "org:engineer",
		createdAtMs: NOW - 40 * DAY,
		isCurrentUser: false,
	},
]

const step = (model: MembersModel.Model, message: MembersModel.Message): MembersModel.Model =>
	MembersUpdate.update(model, message).model

export const init = (flags: Flags): Return => {
	const loaded = Arr.reduce(
		[
			MembersModel.Message.CompletedFetchOrganization({ name: "Acme" }),
			MembersModel.Message.CompletedFetchMembers({
				page: 1,
				generation: 0,
				result: Result.succeed({ rows: ROWS, total: ROWS.length }),
			}),
			MembersModel.Message.CompletedFetchInvitations({
				page: 1,
				generation: 0,
				result: Result.succeed({ rows: [], total: 0 }),
			}),
		],
		MembersUpdate.init(Policy.grantsOf(["org:admin"])).model,
		step,
	)
	const pending: MembersModel.Model["pendingRole"] =
		flags.state === "list"
			? null
			: {
					_tag: flags.state === "saving" ? "Saving" : "Confirming",
					memberId: "user_miguel",
					name: "Miguel Santos",
					next: "org:engineer",
				}
	return { model: { members: { ...loaded, pendingRole: pending } } }
}

/** Kit commands run; every Clerk read and write is dropped, so a confirm stays saving. */
export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotMembersMessage: ({ message: child }) => {
			const next = MembersUpdate.update(model.members, child)
			return {
				model: { members: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (message) =>
					Message.GotMembersMessage({ message }),
				),
			}
		},
	})

export const breadcrumbs = [{ label: "Lab", href: "/lab" }, { label: "Members" }] as const

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("mx-auto w-full max-w-4xl p-6")],
		[
			h.submodel({
				slotId: "lab-members",
				model: model.members,
				view: MembersView.view,
				viewInputs: { nowMs: NOW, timeZone: TIME_ZONE, isKnownMember: true },
				toParentMessage: (message: MembersModel.Message) => Message.GotMembersMessage({ message }),
			}),
		],
	)
