import { organizationHomeRegion } from "@maple/domain/organization-regions"
import { Effect, Option, Result, Schema } from "effect"
import { AsyncData, Command, File } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import { clerkTry, currentClerkOrganization, currentClerkUser, switchAwayFrom } from "../../../platform/clerk"
import * as Dialog from "../../../ui/dialog"
import { PageOutMessage, type PageReturn } from "../../contract"
import { revisitData } from "../kit/revisit"
import * as Draft from "../kit/draft"
import { checkImage, clickFileInput } from "../kit/image-dropzone"
import { memberDisplayName } from "../kit/members"
import { AdminsInfo, Message, type Model, OrgInfo } from "./model"

type Return = PageReturn<Model, Message>

export const LOGO_INPUT_ID = "org-logo-input"

const sameString = (a: string, b: string) => a === b

const toResult =
	<A, E, B>(toMessage: (result: Result.Result<A, string>) => B) =>
	(effect: Effect.Effect<A, E & { readonly message: string }>) =>
		effect.pipe(
			Effect.mapError((error) => error.message),
			Effect.result,
			Effect.map(toMessage),
		)

export const FetchOrganization = Command.define("FetchClerkOrganization", {
	messages: [Message.CompletedFetchOrganization],
	execute: Effect.sync(() => window.Clerk?.organization ?? null).pipe(
		Effect.map((organization): OrgInfo | null =>
			organization === null
				? null
				: {
						id: organization.id,
						name: organization.name,
						hasImage: organization.hasImage,
						region: organizationHomeRegion(organization.publicMetadata),
					},
		),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchOrganization({ result })),
	),
})

/** `useOrganization({ memberships: { role: ["org:admin"], pageSize: 1 } })`. */
export const FetchAdmins = Command.define("FetchClerkOrganizationAdmins", {
	messages: [Message.CompletedFetchAdmins],
	execute: currentClerkOrganization.pipe(
		Effect.flatMap((organization) =>
			clerkTry("Failed to load admins", () =>
				organization.getMemberships({ role: ["org:admin"], pageSize: 1 }),
			),
		),
		Effect.map((page): AdminsInfo => ({
			count: page.total_count,
			firstAdminName: memberDisplayName(page.data[0]?.publicUserData) ?? null,
		})),
		Effect.mapError(toLoadFailure),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchAdmins({ result })),
	),
})

const RenameOrganization = Command.define("RenameClerkOrganization", {
	args: { submitted: Schema.String, sent: Schema.String },
	messages: [Message.CompletedSaveName],
	execute: ({ submitted, sent }) =>
		currentClerkOrganization.pipe(
			Effect.flatMap((organization) =>
				clerkTry("Failed to rename organization", () => organization.update({ name: sent })),
			),
			Effect.asVoid,
			toResult((result) => Message.CompletedSaveName({ submitted, sent, result })),
		),
})

const PickLogo = Command.define("PickOrganizationLogo", {
	messages: [Message.CompletedPickLogo],
	execute: clickFileInput(LOGO_INPUT_ID).pipe(Effect.as(Message.CompletedPickLogo())),
})

const SetLogo = Command.define("SetClerkOrganizationLogo", {
	args: { file: Schema.NullOr(File.File) },
	messages: [Message.CompletedSetLogo],
	execute: ({ file }) =>
		currentClerkOrganization.pipe(
			Effect.flatMap((organization) =>
				clerkTry(file === null ? "Failed to remove logo" : "Failed to update logo", () =>
					organization.setLogo({ file }),
				),
			),
			Effect.asVoid,
			toResult((result) => Message.CompletedSetLogo({ isRemoved: file === null, result })),
		),
})

const LeaveOrganization = Command.define("LeaveClerkOrganization", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLeave],
	execute: ({ orgId }) =>
		currentClerkUser.pipe(
			Effect.flatMap((user) =>
				clerkTry("Failed to leave organization", () => user.leaveOrganization(orgId)),
			),
			Effect.asVoid,
			toResult((result) => Message.CompletedLeave({ result })),
		),
})

const DeleteOrganization = Command.define("DeleteOrganization", {
	messages: [Message.CompletedDelete],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.organizations.delete()).pipe(
		Effect.asVoid,
		Effect.mapError(toLoadFailure),
		Effect.result,
		Effect.map((result) => Message.CompletedDelete({ result })),
	),
})

/** `switchAway`: another organization (or none) becomes active, then home. */
const SwitchAway = Command.define("SwitchAwayFromOrganization", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedSwitchAway],
	execute: ({ orgId }) => switchAwayFrom(orgId).pipe(Effect.as(Message.CompletedSwitchAway())),
})

export const init = (isAdmin: boolean): Return => ({
	model: {
		isAdmin,
		org: AsyncData.Loading(),
		admins: AsyncData.Loading(),
		name: Draft.emptyDraft(),
		isSavingName: false,
		isSavingLogo: false,
		isDragging: false,
		leaveDialog: Dialog.init("org-leave", "alert-dialog"),
		isLeaving: false,
		deleteDialog: Dialog.init("org-delete", "alert-dialog"),
		confirmText: "",
		isDeleting: false,
	},
	commands: [FetchOrganization(), FetchAdmins()],
})

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

/** The active organization, once loaded. */
export const orgOf = (model: Model): Option.Option<OrgInfo> =>
	Option.flatMap(AsyncData.getData(model.org), Option.fromNullishOr)

const savedName = (model: Model): string =>
	Option.getOrElse(
		Option.map(orgOf(model), (org) => org.name),
		() => "",
	)

export const nameDraftOf = (model: Model): string => Draft.draftOf(model.name, savedName(model))
export const isNameDirty = (model: Model): boolean => Draft.isDirty(model.name, savedName(model), sameString)

export type LeaveEligibility = "allowed" | "checking" | "last-admin"

/** `leaveEligibility`: the last admin cannot leave; the count is unknown while it loads. */
export const leaveEligibilityOf = (model: Model): LeaveEligibility => {
	if (!model.isAdmin) return "allowed"
	return Option.match(AsyncData.getData(model.admins), {
		onNone: () => "checking",
		onSome: (admins) => (admins.count > 1 ? "allowed" : "last-admin"),
	})
}

const orgIdOf = (model: Model): Option.Option<string> => Option.map(orgOf(model), (org) => org.id)

const liftLeave = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, leaveDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotLeaveDialogMessage({ message }),
	),
})

const liftDelete = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, deleteDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotDeleteDialogMessage({ message }),
	),
})

const isConfirmMatching = (model: Model): boolean => model.confirmText.trim() === savedName(model)

/** `handleDeleteDialogChange`: closing the dialog clears the typed name. */
const deleteDialogStep = (model: Model, step: ReturnType<typeof Dialog.update>): Return => {
	const lifted = liftDelete(model, step)
	return step.outMessage?._tag === "Closed"
		? { ...lifted, model: { ...lifted.model, confirmText: "" } }
		: lifted
}

const startLogo = (model: Model, file: File.File | null): Return =>
	!model.isAdmin || model.isSavingLogo
		? { model }
		: { model: { ...model, isSavingLogo: true, isDragging: false }, commands: [SetLogo({ file })] }

/** Back on the tab: the organization and its admins stay up while they load again. */
export const revisit = (model: Model): Return => {
	const org = revisitData(model.org, FetchOrganization)
	const admins = revisitData(model.admins, FetchAdmins)
	return {
		model: { ...model, org: org.data, admins: admins.data },
		commands: [...org.commands, ...admins.commands],
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedFetchOrganization: ({ result }) => {
			const org = AsyncData.settle(model.org, result)
			const saved = Option.getOrElse(
				Option.flatMap(AsyncData.getData(org), (data) => Option.fromNullishOr(data?.name)),
				() => "",
			)
			return { model: { ...model, org, name: Draft.settle(model.name, saved, sameString) } }
		},
		CompletedFetchAdmins: ({ result }) => ({
			model: { ...model, admins: AsyncData.settle(model.admins, result) },
		}),
		ChangedName: ({ value }) => ({ model: { ...model, name: Draft.setDraft(model.name, value) } }),
		ClickedDiscardName: () => ({ model: { ...model, name: Draft.discard() } }),
		ClickedSaveName: () => {
			const submitted = nameDraftOf(model)
			const sent = submitted.trim()
			if (model.isSavingName || sent.length === 0) return { model }
			return {
				model: { ...model, isSavingName: true, name: Draft.submit(model.name, savedName(model)) },
				commands: [RenameOrganization({ submitted, sent })],
			}
		},
		CompletedSaveName: ({ submitted, sent, result }) =>
			Result.match(result, {
				onSuccess: () => ({
					model: {
						...model,
						isSavingName: false,
						name: Draft.commit(model.name, { submitted, sent }, savedName(model), sameString),
					},
					commands: [FetchOrganization()],
					outMessage: toast("success", "Organization renamed"),
				}),
				onFailure: (error) => ({
					model: { ...model, isSavingName: false, name: Draft.abort(model.name) },
					outMessage: toast("error", error),
				}),
			}),
		ClickedPickLogo: () =>
			!model.isAdmin || model.isSavingLogo ? { model } : { model, commands: [PickLogo()] },
		CompletedPickLogo: () => ({ model }),
		DraggedOverLogo: () => ({ model: { ...model, isDragging: true } }),
		LeftLogo: () => ({ model: { ...model, isDragging: false } }),
		PickedLogo: ({ files }) =>
			Option.match(Option.fromNullishOr(files[0]), {
				onNone: () => ({ model: { ...model, isDragging: false } }),
				onSome: (file) =>
					Option.match(checkImage(file), {
						onNone: () => startLogo(model, file),
						onSome: (problem) => ({
							model: { ...model, isDragging: false },
							outMessage: toast("error", problem),
						}),
					}),
			}),
		ClickedRemoveLogo: () => startLogo(model, null),
		CompletedSetLogo: ({ isRemoved, result }) =>
			Result.match(result, {
				onSuccess: () => ({
					model: { ...model, isSavingLogo: false },
					commands: [FetchOrganization()],
					outMessage: toast(
						"success",
						isRemoved ? "Organization logo removed" : "Organization logo updated",
					),
				}),
				onFailure: (error) => ({
					model: { ...model, isSavingLogo: false },
					outMessage: toast("error", error),
				}),
			}),
		ClickedLeave: () => liftLeave(model, Dialog.open(model.leaveDialog)),
		GotLeaveDialogMessage: ({ message: child }) =>
			model.isLeaving ? { model } : liftLeave(model, Dialog.update(model.leaveDialog, child)),
		ClickedConfirmLeave: () =>
			Option.match(orgIdOf(model), {
				onNone: () => ({ model }),
				onSome: (orgId) =>
					model.isLeaving || leaveEligibilityOf(model) !== "allowed"
						? { model }
						: { model: { ...model, isLeaving: true }, commands: [LeaveOrganization({ orgId })] },
			}),
		CompletedLeave: ({ result }) =>
			Result.match(result, {
				onSuccess: () => ({
					...liftLeave(model, Dialog.close(model.leaveDialog)),
					commands: Option.match(orgIdOf(model), {
						onNone: () => [],
						onSome: (orgId) => [SwitchAway({ orgId })],
					}),
					outMessage: toast("success", `You left ${savedName(model)}`),
				}),
				onFailure: (error) => ({
					model: { ...model, isLeaving: false },
					outMessage: toast("error", error),
				}),
			}),
		ClickedDelete: () => liftDelete(model, Dialog.open(model.deleteDialog)),
		GotDeleteDialogMessage: ({ message: child }) =>
			model.isDeleting ? { model } : deleteDialogStep(model, Dialog.update(model.deleteDialog, child)),
		ChangedConfirmText: ({ value }) => ({ model: { ...model, confirmText: value } }),
		ClickedConfirmDelete: () =>
			model.isDeleting || !isConfirmMatching(model)
				? { model }
				: { model: { ...model, isDeleting: true }, commands: [DeleteOrganization()] },
		CompletedDelete: ({ result }) =>
			Result.match(result, {
				onSuccess: () => {
					const closed = liftDelete({ ...model, confirmText: "" }, Dialog.close(model.deleteDialog))
					return {
						...closed,
						commands: [
							...(closed.commands ?? []),
							...Option.match(orgIdOf(model), {
								onNone: () => [],
								onSome: (orgId) => [SwitchAway({ orgId })],
							}),
						],
						outMessage: toast("success", "Organization deleted"),
					}
				},
				onFailure: (error) => ({
					model: { ...model, isDeleting: false },
					outMessage: toast("error", "Failed to delete organization", error.message),
				}),
			}),
		CompletedSwitchAway: () => ({
			model: { ...model, name: Draft.discard() },
			outMessage: PageOutMessage.RequestedNavigation({ url: "/", isReplace: false }),
		}),
	})
