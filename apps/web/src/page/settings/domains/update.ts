import { Array, Effect, Option, pipe, Result, Schema, String as Str } from "effect"
import { AsyncData, Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import type { ClerkOrganizationDomainResource } from "../../../platform/clerk"
import { ClerkActionError, clerkTry, currentClerkOrganization } from "../../../platform/clerk"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as Menu from "@maple/views/ui/menu"
import * as Select from "@maple/views/ui/select"
import { PageOutMessage, type PageReturn } from "../../contract"
import { revisitData } from "../kit/revisit"
import { type DomainRow, Enrollment, Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

/** Clerk's page cap; an organization claims a handful of domains, so one page is the list. */
const PAGE_SIZE = 100

export const ENROLLMENTS = Enrollment.literals

const toRow = (domain: ClerkOrganizationDomainResource): DomainRow => ({
	id: domain.id,
	name: domain.name,
	isVerified: domain.verification?.status === "verified",
	enrollment: domain.enrollmentMode,
	affiliationEmail: domain.affiliationEmailAddress,
})

const settleClerk =
	<B>(toMessage: (result: Result.Result<void, string>) => B) =>
	<A>(effect: Effect.Effect<A, ClerkActionError>) =>
		effect.pipe(
			Effect.asVoid,
			Effect.mapError((error) => error.message),
			Effect.result,
			Effect.map(toMessage),
		)

const domainsPage = currentClerkOrganization.pipe(
	Effect.flatMap((organization) =>
		clerkTry("Couldn't load domains", () => organization.getDomains({ pageSize: PAGE_SIZE })),
	),
)

const FetchOrganization = Command.define("FetchDomainsOrganization", {
	messages: [Message.CompletedFetchOrganization],
	execute: Effect.sync(() =>
		Message.CompletedFetchOrganization({ hasOrganization: window.Clerk?.organization != null }),
	),
})

export const FetchDomains = Command.define("FetchClerkDomains", {
	messages: [Message.CompletedFetchDomains],
	execute: domainsPage.pipe(
		Effect.map((page) => Array.map(page.data, toRow)),
		settleTo((result) => Message.CompletedFetchDomains({ result })),
	),
})

const withDomain = <A>(
	id: string,
	use: (domain: ClerkOrganizationDomainResource) => Effect.Effect<A, ClerkActionError>,
) =>
	domainsPage.pipe(
		Effect.flatMap((page) =>
			Option.match(
				Array.findFirst(page.data, (domain) => domain.id === id),
				{
					onNone: () =>
						Effect.fail(
							new ClerkActionError({ message: "That domain was removed", cause: undefined }),
						),
					onSome: use,
				},
			),
		),
	)

const AddDomain = Command.define("CreateClerkDomain", {
	args: { name: Schema.String },
	messages: [Message.CompletedAdd],
	execute: ({ name }) =>
		currentClerkOrganization.pipe(
			Effect.flatMap((organization) =>
				clerkTry("Couldn't add domain", () => organization.createDomain(name)),
			),
			Effect.mapBoth({ onSuccess: toRow, onFailure: (error) => error.message }),
			Effect.result,
			Effect.map((result) => Message.CompletedAdd({ result })),
		),
})

const SendCode = Command.define("PrepareClerkDomainVerification", {
	args: { id: Schema.String, email: Schema.String },
	messages: [Message.CompletedSendCode],
	execute: ({ id, email }) =>
		withDomain(id, (domain) =>
			clerkTry("Couldn't send the code", () =>
				domain.prepareAffiliationVerification({ affiliationEmailAddress: email }),
			),
		).pipe(settleClerk((result) => Message.CompletedSendCode({ id, email, result }))),
})

const AttemptCode = Command.define("AttemptClerkDomainVerification", {
	args: { id: Schema.String, name: Schema.String, code: Schema.String },
	messages: [Message.CompletedAttemptCode],
	execute: ({ id, name, code }) =>
		withDomain(id, (domain) =>
			clerkTry("That code didn't work", () => domain.attemptAffiliationVerification({ code })),
		).pipe(settleClerk((result) => Message.CompletedAttemptCode({ id, name, result }))),
})

/** Turning auto-invite off also withdraws the invitations it already sent. */
const SetEnrollment = Command.define("UpdateClerkDomainEnrollment", {
	args: { id: Schema.String, name: Schema.String, next: Enrollment },
	messages: [Message.CompletedEnrollment],
	execute: ({ id, name, next }) =>
		withDomain(id, (domain) =>
			clerkTry("Couldn't change who joins", () =>
				domain.updateEnrollmentMode({
					enrollmentMode: next,
					deletePending: next === "manual_invitation",
				}),
			),
		).pipe(settleClerk((result) => Message.CompletedEnrollment({ id, name, next, result }))),
})

const RemoveDomain = Command.define("DeleteClerkDomain", {
	args: { id: Schema.String, name: Schema.String },
	messages: [Message.CompletedRemove],
	execute: ({ id, name }) =>
		withDomain(id, (domain) => clerkTry("Couldn't remove domain", () => domain.delete())).pipe(
			settleClerk((result) => Message.CompletedRemove({ name, result })),
		),
})

const enrollmentSelect = (id: string, enrollment: DomainRow["enrollment"]): Select.Model =>
	Select.init(`domain-enrollment-${id}`, {
		value: enrollment,
		selectedIndex: Option.getOrNull(Array.findFirstIndex(ENROLLMENTS, (mode) => mode === enrollment)),
	})

export const enrollmentSelectFor = (model: Model, row: DomainRow): Select.Model =>
	model.enrollmentSelects[row.id] ?? enrollmentSelect(row.id, row.enrollment)

export const init = (): Return => ({
	model: {
		hasOrganization: null,
		domains: AsyncData.Loading(),
		addDialog: Dialog.init("domain-add", "dialog"),
		domainField: Field.init(),
		isAdding: false,
		verifying: null,
		verifyDialog: Dialog.init("domain-verify", "dialog"),
		emailField: Field.init(),
		codeField: Field.init(),
		isVerifyPending: false,
		enrollmentSelects: {},
		savingEnrollment: [],
		rowMenus: {},
		removing: null,
		removeDialog: Dialog.init("domain-remove", "alert-dialog"),
		isRemoving: false,
	},
	commands: [FetchOrganization(), FetchDomains()],
})

export const revisit = (model: Model): Return => {
	const domains = revisitData(model.domains, FetchDomains)
	return { model: { ...model, domains: domains.data }, commands: domains.commands }
}

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const lift =
	<K extends "addDialog" | "verifyDialog" | "removeDialog">(
		key: K,
		wrap: (message: Dialog.Message) => Message,
	) =>
	(model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
		model: { ...model, [key]: step.model },
		commands: Command.mapMessages(step.commands ?? [], wrap),
	})

const liftAdd = lift("addDialog", (message) => Message.GotAddDialogMessage({ message }))
const liftVerify = lift("verifyDialog", (message) => Message.GotVerifyDialogMessage({ message }))
const liftRemove = lift("removeDialog", (message) => Message.GotRemoveDialogMessage({ message }))

const refetch = (model: Model): Return => ({
	model: { ...model, domains: Option.getOrElse(AsyncData.revalidate(model.domains), () => model.domains) },
	commands: [FetchDomains()],
})

const merge = (first: Return, second: Return): Return => ({
	...second,
	commands: [...(first.commands ?? []), ...(second.commands ?? [])],
})

/** `Acme.com.`, `ops@acme.com` and `https://acme.com/?to=a@b.com` all mean `acme.com`. */
export const normalizeDomain = (raw: string): string =>
	pipe(
		Str.toLowerCase(Str.trim(raw)),
		Str.replace(/^https?:\/\//, ""),
		// The path goes before the `@` split, so an address in a query never becomes the domain.
		Str.replace(/[/?#].*$/, ""),
		Str.replace(/^.*@/, ""),
		Str.replace(/\.$/, ""),
	)

/** The address must be on the domain itself; Clerk refuses any other. */
export const isOnDomain = (email: string, domain: string): boolean =>
	Str.endsWith(`@${domain}`)(Str.toLowerCase(Str.trim(email)))

const openVerify = (model: Model, row: DomainRow): Return =>
	liftVerify(
		{
			...model,
			verifying: { id: row.id, name: row.name, step: "email", email: row.affiliationEmail ?? "" },
			emailField: Field.init(row.affiliationEmail ?? ""),
			codeField: Field.init(),
			isVerifyPending: false,
		},
		Dialog.open(model.verifyDialog),
	)

const rowOf = (model: Model, id: string): Option.Option<DomainRow> =>
	Option.flatMap(AsyncData.getData(model.domains), (rows) => Array.findFirst(rows, (row) => row.id === id))

const fieldStep = (
	model: Model,
	key: "domainField" | "emailField" | "codeField",
	child: Field.Message,
	wrap: (message: Field.Message) => Message,
): Return => {
	const step = Field.update(model[key], child)
	return {
		model: { ...model, [key]: step.model },
		commands: Command.mapMessages(step.commands ?? [], wrap),
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedFetchOrganization: ({ hasOrganization }) => ({ model: { ...model, hasOrganization } }),
		CompletedFetchDomains: ({ result }) => ({
			model: { ...model, domains: AsyncData.settle(model.domains, result), enrollmentSelects: {} },
		}),
		ClickedRetry: () => ({
			model: { ...model, domains: AsyncData.Loading() },
			commands: [FetchDomains()],
		}),
		ClickedAdd: () => liftAdd(model, Dialog.open(model.addDialog)),
		GotAddDialogMessage: ({ message: child }) =>
			model.isAdding ? { model } : liftAdd(model, Dialog.update(model.addDialog, child)),
		GotDomainFieldMessage: ({ message: child }) =>
			fieldStep(model, "domainField", child, (inner) =>
				Message.GotDomainFieldMessage({ message: inner }),
			),
		SubmittedAdd: () => {
			const name = normalizeDomain(model.domainField.value)
			if (model.isAdding || name.length === 0) return { model }
			return { model: { ...model, isAdding: true }, commands: [AddDomain({ name })] }
		},
		CompletedAdd: ({ result }) =>
			Result.match(result, {
				// Straight on to proving it: an unverified domain does nothing yet.
				onSuccess: (row) => {
					const closed = liftAdd(
						{ ...model, isAdding: false, domainField: Field.init() },
						Dialog.close(model.addDialog),
					)
					const refreshed = merge(closed, refetch(closed.model))
					// Clerk verifies at once when the admin's own address is on the domain.
					return row.isVerified
						? { ...refreshed, outMessage: toast("success", `${row.name} verified`) }
						: merge(refreshed, openVerify(refreshed.model, row))
				},
				onFailure: (error) => ({
					model: { ...model, isAdding: false },
					outMessage: toast("error", error),
				}),
			}),
		ClickedVerify: ({ id }) =>
			Option.match(rowOf(model, id), {
				onNone: () => ({ model }),
				onSome: (row) => openVerify(model, row),
			}),
		GotVerifyDialogMessage: ({ message: child }) => {
			if (model.isVerifyPending) return { model }
			const step = liftVerify(model, Dialog.update(model.verifyDialog, child))
			return step.model.verifyDialog.isOpen
				? step
				: { ...step, model: { ...step.model, verifying: null } }
		},
		GotEmailFieldMessage: ({ message: child }) =>
			fieldStep(model, "emailField", child, (inner) =>
				Message.GotEmailFieldMessage({ message: inner }),
			),
		GotCodeFieldMessage: ({ message: child }) =>
			fieldStep(model, "codeField", child, (inner) => Message.GotCodeFieldMessage({ message: inner })),
		SubmittedVerify: () => {
			const verifying = model.verifying
			if (verifying === null || model.isVerifyPending) return { model }
			if (verifying.step === "email") {
				const email = Str.trim(model.emailField.value)
				if (!isOnDomain(email, verifying.name)) return { model }
				return {
					model: { ...model, isVerifyPending: true },
					commands: [SendCode({ id: verifying.id, email })],
				}
			}
			const code = Str.trim(model.codeField.value)
			if (code.length === 0) return { model }
			return {
				model: { ...model, isVerifyPending: true },
				commands: [AttemptCode({ id: verifying.id, name: verifying.name, code })],
			}
		},
		CompletedSendCode: ({ id, email, result }) => {
			const verifying = model.verifying
			if (verifying === null || verifying.id !== id) return { model }
			return Result.match(result, {
				onSuccess: () => ({
					model: {
						...model,
						isVerifyPending: false,
						verifying: { ...verifying, step: "code", email },
						codeField: Field.init(),
					},
					outMessage: toast("success", `Code sent to ${email}`),
				}),
				onFailure: (error) => ({
					model: { ...model, isVerifyPending: false },
					outMessage: toast("error", error),
				}),
			})
		},
		ClickedResendCode: () =>
			model.verifying === null || model.isVerifyPending
				? { model }
				: {
						model: { ...model, isVerifyPending: true },
						commands: [SendCode({ id: model.verifying.id, email: model.verifying.email })],
					},
		ClickedChangeEmail: () =>
			model.verifying === null || model.isVerifyPending
				? { model }
				: { model: { ...model, verifying: { ...model.verifying, step: "email" } } },
		CompletedAttemptCode: ({ id, name, result }) =>
			Result.match(result, {
				onSuccess: () => {
					const closed = liftVerify(
						{ ...model, isVerifyPending: false, verifying: null },
						Dialog.close(model.verifyDialog),
					)
					const refreshed = refetch(closed.model)
					return { ...merge(closed, refreshed), outMessage: toast("success", `${name} verified`) }
				},
				onFailure: (error) => ({
					model: {
						...model,
						isVerifyPending: false,
						verifying: model.verifying?.id === id ? model.verifying : null,
					},
					outMessage: toast("error", error),
				}),
			}),
		GotEnrollmentSelectMessage: ({ id, message: child }) =>
			Option.match(rowOf(model, id), {
				onNone: () => ({ model }),
				onSome: (row) => {
					const step = Select.update(enrollmentSelectFor(model, row), child)
					const next = {
						...model,
						enrollmentSelects: { ...model.enrollmentSelects, [id]: step.model },
					}
					const commands = Command.mapMessages(step.commands ?? [], (inner) =>
						Message.GotEnrollmentSelectMessage({ id, message: inner }),
					)
					const picked = Option.flatMap(Option.fromNullishOr(step.outMessage), (out) =>
						Schema.decodeUnknownOption(Enrollment)(out.value),
					)
					return Option.match(picked, {
						onNone: () => ({ model: next, commands }),
						onSome: (enrollment) =>
							enrollment === row.enrollment || model.savingEnrollment.includes(id)
								? { model: next, commands }
								: {
										model: { ...next, savingEnrollment: [...model.savingEnrollment, id] },
										commands: [
											...commands,
											SetEnrollment({ id, name: row.name, next: enrollment }),
										],
									},
					})
				},
			}),
		CompletedEnrollment: ({ id, name, next, result }) => {
			const saved = {
				...model,
				savingEnrollment: Array.filter(model.savingEnrollment, (row) => row !== id),
			}
			return Result.match(result, {
				onSuccess: () => ({
					...refetch(saved),
					outMessage: toast(
						"success",
						next === "automatic_invitation"
							? `New people from ${name} are invited automatically`
							: `People from ${name} now need an invite`,
					),
				}),
				// The select goes back to what Clerk still holds.
				onFailure: (error) => ({
					model: { ...saved, enrollmentSelects: {} },
					outMessage: toast("error", error),
				}),
			})
		},
		GotRowMenuMessage: ({ menuId, id, message: child }) => {
			const step = Menu.update(model.rowMenus[menuId] ?? Menu.init(menuId), child)
			const next = { ...model, rowMenus: { ...model.rowMenus, [menuId]: step.model } }
			const commands = Command.mapMessages(step.commands ?? [], (inner) =>
				Message.GotRowMenuMessage({ menuId, id, message: inner }),
			)
			if (step.outMessage?._tag !== "SelectedItem") return { model: next, commands }
			return Option.match(rowOf(model, id), {
				onNone: () => ({ model: next, commands }),
				onSome: (row) => {
					const after =
						step.outMessage?.value === "verify"
							? openVerify(next, row)
							: liftRemove(
									{ ...next, removing: { id, name: row.name } },
									Dialog.open(model.removeDialog),
								)
					return { ...after, commands: [...commands, ...(after.commands ?? [])] }
				},
			})
		},
		GotRemoveDialogMessage: ({ message: child }) =>
			model.isRemoving ? { model } : liftRemove(model, Dialog.update(model.removeDialog, child)),
		ClickedConfirmRemove: () =>
			model.removing === null || model.isRemoving
				? { model }
				: {
						model: { ...model, isRemoving: true },
						commands: [RemoveDomain({ id: model.removing.id, name: model.removing.name })],
					},
		CompletedRemove: ({ name, result }) =>
			Result.match(result, {
				onSuccess: () => {
					const closed = liftRemove(
						{ ...model, isRemoving: false, removing: null },
						Dialog.close(model.removeDialog),
					)
					return {
						...merge(closed, refetch(closed.model)),
						outMessage: toast("success", `${name} removed`),
					}
				},
				onFailure: (error) => ({
					model: { ...model, isRemoving: false },
					outMessage: toast("error", error),
				}),
			}),
	})
