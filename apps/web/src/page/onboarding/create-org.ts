import { MapleRegion } from "@maple/domain/organization-regions"
import { Effect, Option, Schema } from "effect"
import { Command, Mount, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { suggestOrganizationName } from "../../lib/onboarding-org-name"
import { currentRegion } from "../../lib/region"
import {
	acceptUserInvitation,
	type ClerkUser,
	pendingUserInvitations,
	signOutOfClerk,
	UserInvitation,
} from "../../platform/clerk"
import type { Resources } from "../../platform/resources"
import { createdTargetOf, createOrganization, switchToOrganization } from "../../shell/clerk-org-switcher"
import { startDitherField } from "../../ui/dither-field"

// `/org-required`: a signed-in user with no organization names their first one (the name guessed from
// their email), picks its region, or joins an organization that already invited them.

export const Model = Schema.TaggedStruct("OrgRequired", {
	name: Schema.String,
	/** The work domain the suggested name came from, for the hint under the field. */
	suggestedFrom: Schema.NullOr(Schema.String),
	region: MapleRegion,
	isCreating: Schema.Boolean,
	errorMessage: Schema.NullOr(Schema.String),
	/** `null` until Clerk answers; a failed read shows none. */
	invitations: Schema.NullOr(Schema.Array(UserInvitation)),
	joiningId: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ChangedName: { value: Schema.String },
	PickedRegion: { region: MapleRegion },
	SubmittedCreate: {},
	SucceededCreate: { orgId: Schema.String },
	FailedCreate: { message: Schema.String },
	LoadedInvitations: { invitations: Schema.Array(UserInvitation) },
	ClickedJoin: { invitationId: Schema.String },
	SucceededJoin: { orgId: Schema.String },
	FailedJoin: { message: Schema.String },
	ClickedSignOut: {},
	/** The page is leaving for the new org (`setActive` then reload), or Clerk is signing out. */
	CompletedLeave: {},
	CompletedMountDitherField: {},
})
export type Message = typeof Message.Type

// COMMANDS

export const LoadInvitations = Command.define("LoadUserInvitations", {
	messages: [Message.LoadedInvitations],
	execute: pendingUserInvitations.pipe(
		Effect.orElseSucceed((): ReadonlyArray<UserInvitation> => []),
		Effect.map((invitations) => Message.LoadedInvitations({ invitations })),
	),
})

export const CreateOrganization = Command.define("CreateFirstOrganization", {
	args: { name: Schema.String, region: MapleRegion },
	messages: [Message.SucceededCreate, Message.FailedCreate],
	execute: ({ name, region }) =>
		createOrganization(name, region).pipe(
			Effect.map((orgId) => Message.SucceededCreate({ orgId })),
			Effect.catch((error) => Effect.succeed(Message.FailedCreate({ message: error.message }))),
		),
})

export const JoinInvitation = Command.define("AcceptUserInvitation", {
	args: { invitationId: Schema.String },
	messages: [Message.SucceededJoin, Message.FailedJoin],
	execute: ({ invitationId }) =>
		acceptUserInvitation(invitationId).pipe(
			Effect.map((orgId) => Message.SucceededJoin({ orgId })),
			Effect.catch((error) => Effect.succeed(Message.FailedJoin({ message: error.message }))),
		),
})

/** Stays pending while the page reloads onto the org; the root's gates take it from there. */
export const LeaveFor = Command.define("OpenFirstOrganization", {
	args: { orgId: Schema.String, targetUrl: Schema.NullOr(Schema.String) },
	messages: [Message.CompletedLeave],
	execute: ({ orgId, targetUrl }) =>
		switchToOrganization(orgId, targetUrl).pipe(Effect.as(Message.CompletedLeave())),
})

const SignOut = Command.define("OrgRequiredSignOut", {
	messages: [Message.CompletedLeave],
	execute: signOutOfClerk.pipe(Effect.as(Message.CompletedLeave())),
})

/** The preview's dithered backdrop, drawn until the canvas unmounts. */
export const MountDitherField = Mount.define("MountOnboardingDitherField", {
	messages: [Message.CompletedMountDitherField],
	execute: ({ element }) =>
		Effect.acquireRelease(
			Effect.sync(() =>
				element instanceof HTMLCanvasElement ? startDitherField(element) : () => undefined,
			),
			(stop) => Effect.sync(stop),
		).pipe(Effect.as(Message.CompletedMountDitherField())),
})

// INIT AND UPDATE

type Result = Update.Return<Model, Message, Resources>

export const init = (maybeUser: Option.Option<ClerkUser>): Result => {
	const suggestion = suggestOrganizationName(
		Option.getOrNull(Option.flatMapNullishOr(maybeUser, (user) => user.email)),
		Option.getOrNull(Option.flatMapNullishOr(maybeUser, (user) => user.fullName)),
	)
	return {
		model: Model.make({
			name: suggestion.name,
			suggestedFrom: suggestion.domain,
			region: currentRegion,
			isCreating: false,
			errorMessage: null,
			invitations: null,
			joiningId: null,
		}),
		commands: [LoadInvitations()],
	}
}

const isBusy = (model: Model): boolean => model.isCreating || model.joiningId !== null

export const update = (model: Model, message: Message): Result =>
	Message.match<Result>(message, {
		ChangedName: ({ value }) => ({ model: { ...model, name: value, errorMessage: null } }),
		PickedRegion: ({ region }) => (isBusy(model) ? { model } : { model: { ...model, region } }),
		SubmittedCreate: () =>
			isBusy(model) || model.name.trim() === ""
				? { model }
				: {
						model: { ...model, isCreating: true, errorMessage: null },
						commands: [CreateOrganization({ name: model.name, region: model.region })],
					},
		SucceededCreate: ({ orgId }) => ({
			model,
			commands: [LeaveFor({ orgId, targetUrl: createdTargetOf(model.region) })],
		}),
		FailedCreate: ({ message: failure }) => ({
			model: {
				...model,
				isCreating: false,
				errorMessage: failure.trim() || "Couldn't create your organization. Try again.",
			},
		}),
		LoadedInvitations: ({ invitations }) => ({ model: { ...model, invitations } }),
		ClickedJoin: ({ invitationId }) =>
			isBusy(model)
				? { model }
				: {
						model: { ...model, joiningId: invitationId, errorMessage: null },
						commands: [JoinInvitation({ invitationId })],
					},
		// An invited org may live in another region; this dashboard reloads and the region gate sends it on.
		SucceededJoin: ({ orgId }) => ({ model, commands: [LeaveFor({ orgId, targetUrl: null })] }),
		FailedJoin: ({ message: failure }) => ({
			model: {
				...model,
				joiningId: null,
				errorMessage: failure.trim() || "Couldn't join that organization. Try again.",
			},
		}),
		ClickedSignOut: () => ({ model, commands: [SignOut()] }),
		CompletedLeave: () => ({ model }),
		CompletedMountDitherField: () => ({ model }),
	})
