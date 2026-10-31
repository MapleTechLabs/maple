import { Effect, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { clerkTry, currentClerkOrganization } from "../../../platform/clerk"
import type { Resources } from "../../../platform/resources"
import * as Combobox from "../../../ui/combobox"
import type { DestinationForm } from "./form"

// `EmailMemberPicker`: workspace members from Clerk's
// memberships. The server re-resolves the picked ids to emails on save, so this is a convenience.
// TODO(destination-dialog): the popup's "Load more" past the first 100 members, and avatar images.

/** Past Clerk's default of 10, so the typeahead searches the whole workspace in one page. */
const PAGE_SIZE = 100

export const MemberOption = Schema.Struct({
	userId: Schema.String,
	label: Schema.String,
	/** The email, when a name is the label. */
	meta: Schema.NullOr(Schema.String),
})
export type MemberOption = typeof MemberOption.Type

export const Model = Schema.Struct({
	members: AsyncData.Schema(Schema.Array(MemberOption), Schema.String).schema,
	combobox: Combobox.Model,
})
export type Model = typeof Model.Type

export const MEMBER_COMBOBOX_ID = "destination-email-members"

export const init = (): Model => ({
	members: AsyncData.Idle(),
	combobox: Combobox.init(MEMBER_COMBOBOX_ID, "multiple"),
})

export const Message = defineMessageUnion({
	CompletedFetchMembers: { result: Schema.Result(Schema.Array(MemberOption), Schema.String) },
	GotComboboxMessage: { message: Combobox.Message },
})
export type Message = typeof Message.Type

export const FetchEmailMembers = Command.define("FetchAlertEmailMembers", {
	messages: [Message.CompletedFetchMembers],
	execute: currentClerkOrganization.pipe(
		Effect.flatMap((organization) =>
			clerkTry("Couldn't load members", () =>
				organization.getMemberships({ initialPage: 1, pageSize: PAGE_SIZE }),
			),
		),
		Effect.map((result) =>
			result.data.flatMap((member): ReadonlyArray<MemberOption> => {
				const user = member.publicUserData
				const userId = user?.userId
				const email = user?.identifier
				if (userId === undefined || userId === null || email === undefined || email === "") return []
				const name = [user?.firstName, user?.lastName].filter((part) => part).join(" ")
				return [{ userId, label: name || email, meta: name ? email : null }]
			}),
		),
		Effect.mapError((error) => error.message),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchMembers({ result })),
	),
})

export type Return = Readonly<{
	model: Model
	commands: ReadonlyArray<Command.Command<Message, never, Resources>>
	form?: Partial<DestinationForm>
}>

const fetchMembers = (model: Model): Return => ({
	model: { ...model, members: AsyncData.Loading() },
	commands: [FetchEmailMembers()],
})

/** The picker mounts: the selection is the form's, and the first page is read once. */
export const reset = (model: Model, form: DestinationForm): Return => {
	const next = {
		...model,
		combobox: Combobox.init(MEMBER_COMBOBOX_ID, "multiple", { selected: form.memberUserIds }),
	}
	return AsyncData.isIdle(model.members) ? fetchMembers(next) : { model: next, commands: [] }
}

/** `itemToStringLabel`: the typeahead matches the label, never the id. */
export const visibleIds = (
	options: ReadonlyArray<MemberOption>,
	inputValue: string,
): ReadonlyArray<string> => {
	const query = inputValue.trim().toLocaleLowerCase()
	return options
		.filter((option) => query === "" || option.label.toLocaleLowerCase().includes(query))
		.map((option) => option.userId)
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedFetchMembers: ({ result }) => ({
			model: { ...model, members: AsyncData.settle(model.members, result) },
			commands: [],
		}),
		GotComboboxMessage: ({ message: inner }) => {
			const step = Combobox.update(model.combobox, inner)
			const commands = Command.mapMessages(step.commands ?? [], (child) =>
				Message.GotComboboxMessage({ message: child }),
			)
			const out = step.outMessage
			const next: Return = { model: { ...model, combobox: step.model }, commands }
			if (out?._tag !== "ChangedSelection") return next
			return { ...next, form: { memberUserIds: [...out.selected] } }
		},
	})
