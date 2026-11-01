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
import { createdTargetOf, createOrganization, openOrganization } from "../../shell/clerk-org-switcher"
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
	/** An org the user already belongs to, being opened (`setActive` then its region's app). */
	openingId: Schema.NullOr(Schema.String),
	/** Created, but not opened yet (Clerk refused `setActive`): Create retries opening it, never a second org. */
	createdOrgId: Schema.NullOr(Schema.String),
	/** Clerk could not list the invitations, so their absence says nothing. */
	invitationsError: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ChangedName: { value: Schema.String },
	PickedRegion: { region: MapleRegion },
	SubmittedCreate: {},
	SucceededCreate: { orgId: Schema.String },
	FailedCreate: { message: Schema.String },
	LoadedInvitations: { invitations: Schema.Array(UserInvitation) },
	FailedLoadInvitations: { message: Schema.String },
	ClickedJoin: { invitationId: Schema.String },
	SucceededJoin: { orgId: Schema.String },
	FailedJoin: { message: Schema.String },
	ClickedOpen: { orgId: Schema.String, targetUrl: Schema.NullOr(Schema.String) },
	ClickedSignOut: {},
	/** The page is leaving for the new org (`setActive` then reload), or Clerk is signing out. */
	CompletedLeave: {},
	/** Clerk refused to make the org active, so the page stays instead of reloading onto no org. */
	FailedLeave: { message: Schema.String },
	CompletedMountDitherField: {},
})
export type Message = typeof Message.Type

// COMMANDS

export const LoadInvitations = Command.define("LoadUserInvitations", {
	messages: [Message.LoadedInvitations, Message.FailedLoadInvitations],
	execute: pendingUserInvitations.pipe(
		Effect.map((invitations) => Message.LoadedInvitations({ invitations })),
		Effect.catch((error) => Effect.succeed(Message.FailedLoadInvitations({ message: error.message }))),
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
	messages: [Message.CompletedLeave, Message.FailedLeave],
	execute: ({ orgId, targetUrl }) =>
		openOrganization(orgId, targetUrl).pipe(
			Effect.as(Message.CompletedLeave()),
			Effect.catch((error) => Effect.succeed(Message.FailedLeave({ message: error.message }))),
		),
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
			openingId: null,
			createdOrgId: null,
			invitationsError: null,
		}),
		commands: [LoadInvitations()],
	}
}

const isBusy = (model: Model): boolean =>
	model.isCreating || model.joiningId !== null || model.openingId !== null

export const update = (model: Model, message: Message): Result =>
	Message.match<Result>(message, {
		ChangedName: ({ value }) => ({ model: { ...model, name: value, errorMessage: null } }),
		PickedRegion: ({ region }) => (isBusy(model) ? { model } : { model: { ...model, region } }),
		SubmittedCreate: () =>
			isBusy(model) || model.name.trim() === ""
				? { model }
				: {
						model: { ...model, isCreating: true, errorMessage: null },
						commands: [
							model.createdOrgId === null
								? CreateOrganization({ name: model.name, region: model.region })
								: LeaveFor({
										orgId: model.createdOrgId,
										targetUrl: createdTargetOf(model.region),
									}),
						],
					},
		SucceededCreate: ({ orgId }) => ({
			model: { ...model, createdOrgId: orgId },
			commands: [LeaveFor({ orgId, targetUrl: createdTargetOf(model.region) })],
		}),
		FailedCreate: ({ message: failure }) => ({
			model: {
				...model,
				isCreating: false,
				errorMessage: failure.trim() || "Couldn't create your organization. Try again.",
			},
		}),
		LoadedInvitations: ({ invitations }) => ({
			model: { ...model, invitations, invitationsError: null },
		}),
		FailedLoadInvitations: ({ message: failure }) => ({
			model: { ...model, invitations: [], invitationsError: failure.trim() || "Clerk did not answer." },
		}),
		ClickedJoin: ({ invitationId }) =>
			isBusy(model)
				? { model }
				: {
						model: { ...model, joiningId: invitationId, errorMessage: null },
						commands: [JoinInvitation({ invitationId })],
					},
		// An invited org may live in another region: the reload lands on its wrong-region notice, one click from there.
		SucceededJoin: ({ orgId }) => ({ model, commands: [LeaveFor({ orgId, targetUrl: null })] }),
		FailedJoin: ({ message: failure }) => ({
			model: {
				...model,
				joiningId: null,
				errorMessage: failure.trim() || "Couldn't join that organization. Try again.",
			},
			// Accepted in another tab: the re-read drops the row, and the org shows up among the user's own.
			commands: [LoadInvitations()],
		}),
		ClickedOpen: ({ orgId, targetUrl }) =>
			isBusy(model)
				? { model }
				: {
						model: { ...model, openingId: orgId, errorMessage: null },
						commands: [LeaveFor({ orgId, targetUrl })],
					},
		ClickedSignOut: () => ({ model, commands: [SignOut()] }),
		CompletedLeave: () => ({ model }),
		FailedLeave: ({ message: failure }) => ({
			model: { ...model, isCreating: false, joiningId: null, openingId: null, errorMessage: failure },
		}),
		CompletedMountDitherField: () => ({ model }),
	})
