import {
	DEFAULT_RUN_BUDGET,
	type GithubRepoSummary,
	SECURITY_AUDIT_MAX_BUDGET,
	SecurityAuditBranch,
	SecurityAuditCreateTargetRequest,
	SecurityAuditRepository,
	SecurityAuditRun,
	SecurityAuditTarget,
} from "@maple/domain/http"
import { isSafeScopePath, SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Effect, Option, Result, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import type { Resources } from "../../../platform/resources"
import * as Dialog from "../../../ui/dialog"
import * as Field from "../../../ui/field"
import * as RadioGroup from "../../../ui/radio-group"
import * as Select from "../../../ui/select"
import { createTarget, startRun } from "./api"

// The Add target dialog: repository, branch, profile, scope and budget, then the first run.
// The parent holds the GitHub status; this module owns the form and its two writes.

type ProfileChoice = "deep" | "quick"

export const MAX_SCOPE_PATHS = 100
/** The API refuses a longer scope path. */
const MAX_SCOPE_PATH_LENGTH = 512
export const DIALOG_ID = "security-add-target"

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	repository: Select.Model,
	branch: Field.Model,
	profile: RadioGroup.Model,
	scopeDraft: Field.Model,
	scopePaths: Schema.Array(Schema.String),
	budget: Field.Model,
	startNow: Schema.Boolean,
	/** Errors show once the form was submitted, so an untouched field is not red. */
	isSubmitted: Schema.Boolean,
	isPending: Schema.Boolean,
	/** Bumped each time the form opens: an answer for an earlier attempt is dropped. */
	attempt: Schema.Finite,
	failure: Schema.NullOr(LoadFailure),
	/** The target the form created, while its first run is starting. */
	created: Schema.NullOr(SecurityAuditTarget),
})
export type Model = typeof Model.Type

export const init = (): Model => ({
	dialog: Dialog.init(DIALOG_ID, "dialog"),
	repository: Select.init(`${DIALOG_ID}-repository`, { value: "", selectedIndex: null }),
	branch: Field.init(),
	profile: RadioGroup.init("deep"),
	scopeDraft: Field.init(),
	scopePaths: [],
	budget: Field.init(String(DEFAULT_RUN_BUDGET)),
	startNow: true,
	isSubmitted: false,
	isPending: false,
	attempt: 0,
	failure: null,
	created: null,
})

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	GotRepositoryMessage: { message: Select.Message },
	GotBranchMessage: { message: Field.Message },
	GotProfileMessage: { message: RadioGroup.Message },
	GotScopeMessage: { message: Field.Message },
	AddedScopePath: {},
	RemovedScopePath: { path: Schema.String },
	GotBudgetMessage: { message: Field.Message },
	ToggledStartNow: {},
	Submitted: {},
	CompletedCreate: { attempt: Schema.Finite, result: Schema.Result(SecurityAuditTarget, LoadFailure) },
	CompletedStartFirstRun: { attempt: Schema.Finite, result: Schema.Result(SecurityAuditRun, LoadFailure) },
})
export type Message = typeof Message.Type

/** What the page does next: re-read targets and runs, and open the first run if one started. */
export const OutMessage = defineMessageUnion({
	Added: { target: SecurityAuditTarget, run: Schema.NullOr(SecurityAuditRun) },
	/** The target exists but its first run did not start; the page says why. */
	AddedWithoutRun: { target: SecurityAuditTarget, failure: LoadFailure },
})
export type OutMessage = typeof OutMessage.Type

export const CreateSecurityTarget = Command.define("SecurityApiCreateTarget", {
	args: { attempt: Schema.Finite, payload: SecurityAuditCreateTargetRequest },
	messages: [Message.CompletedCreate],
	execute: ({ attempt, payload }) =>
		Effect.map(createTarget(payload), (result) => Message.CompletedCreate({ attempt, result })),
})

export const StartFirstRun = Command.define("SecurityApiStartFirstRun", {
	args: { attempt: Schema.Finite, targetId: SecurityAuditTargetId },
	messages: [Message.CompletedStartFirstRun],
	execute: ({ attempt, targetId }) =>
		Effect.map(startRun(targetId), (result) => Message.CompletedStartFirstRun({ attempt, result })),
})

// VALIDATION

const isRepository = Schema.is(SecurityAuditRepository)
const isBranch = Schema.is(SecurityAuditBranch)

export type Errors = Readonly<{
	repository: string | undefined
	branch: string | undefined
	scope: string | undefined
	budget: string | undefined
}>

const parseBudget = (value: string): number | null => {
	const trimmed = value.trim()
	if (trimmed === "") return DEFAULT_RUN_BUDGET
	const parsed = Number(trimmed)
	return Number.isInteger(parsed) && parsed >= 1 && parsed <= SECURITY_AUDIT_MAX_BUDGET ? parsed : null
}

/** The draft path is a scope path once added; a bad one is reported on the draft. */
/** The paths the request would send: the added ones and the draft, once. */
const pathsOf = (model: Model): ReadonlyArray<string> => {
	const draft = model.scopeDraft.value.trim()
	return draft === "" || model.scopePaths.includes(draft) ? model.scopePaths : [...model.scopePaths, draft]
}

const draftError = (draft: string): string | undefined =>
	draft === ""
		? undefined
		: draft.length > MAX_SCOPE_PATH_LENGTH
			? `Keep each path under ${MAX_SCOPE_PATH_LENGTH} characters.`
			: isSafeScopePath(draft)
				? undefined
				: "Use a path inside the repository, like services/payments/src, without .. or a leading slash."

/** The draft is checked as it would be sent, and it counts toward the cap like an added path. */
const scopeError = (model: Model): string | undefined =>
	draftError(model.scopeDraft.value.trim()) ??
	(pathsOf(model).length > MAX_SCOPE_PATHS ? `At most ${MAX_SCOPE_PATHS} scope paths.` : undefined)

export const errorsOf = (model: Model): Errors => ({
	repository: isRepository(model.repository.value) ? undefined : "Pick a repository.",
	branch: isBranch(model.branch.value.trim()) ? undefined : "Enter a branch name git would accept.",
	scope: scopeError(model),
	budget:
		parseBudget(model.budget.value) === null
			? `Enter a whole number from 1 to ${SECURITY_AUDIT_MAX_BUDGET.toLocaleString("en-US")}.`
			: undefined,
})

export const NO_ERRORS: Errors = {
	repository: undefined,
	branch: undefined,
	scope: undefined,
	budget: undefined,
}

export const hasErrors = (errors: Errors): boolean =>
	Object.values(errors).some((error) => error !== undefined)

export const profileOf = (model: Model): ProfileChoice =>
	Option.getOrElse(model.profile.maybeValue, () => "deep") === "quick" ? "quick" : "deep"

/** The request the form describes; the draft path counts as added. */
export const requestOf = (model: Model): SecurityAuditCreateTargetRequest | null => {
	if (hasErrors(errorsOf(model))) return null
	const draft = model.scopeDraft.value.trim()
	const scopePaths =
		draft === "" || model.scopePaths.includes(draft) ? model.scopePaths : [...model.scopePaths, draft]
	const request: SecurityAuditCreateTargetRequest = {
		repository: model.repository.value,
		branch: model.branch.value.trim(),
		profile: profileOf(model),
		budgetPerRun: parseBudget(model.budget.value) ?? DEFAULT_RUN_BUDGET,
	}
	return scopePaths.length === 0 ? request : { ...request, scopePaths }
}

/** A server answer that belongs next to a field rather than above the form. */
export const fieldFailure = (
	failure: LoadFailure | null,
): Readonly<{ field: "repository" | "branch"; message: string }> | null =>
	failure === null
		? null
		: failure.code === "security_audit_repository_not_connected"
			? {
					field: "repository",
					message:
						"Maple's GitHub App cannot read this repository. Grant it access in GitHub, then try again.",
				}
			: failure.code === "security_audit_target_exists"
				? {
						field: "branch",
						message: "This branch is already a target. Open it from the targets table.",
					}
				: null

// UPDATE

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

const defaultBranch = (repo: GithubRepoSummary): string =>
	repo.trackedBranch ?? repo.branches.find((branch) => branch.isDefault)?.name ?? ""

const DISMISSALS: ReadonlySet<string> = new Set(["ClickedClose", "PressedEscape", "PressedOutside"])

/** Opening resets the form, so the dialog never shows a previous attempt. */
export const open = (model: Model): Return => {
	const fresh = init()
	const step = Dialog.open(model.dialog)
	return {
		model: { ...fresh, dialog: step.model, attempt: model.attempt + 1 },
		commands: Command.mapMessages(step.commands ?? [], (message) =>
			Message.GotDialogMessage({ message }),
		),
	}
}

const close = (model: Model): Return => {
	const step = Dialog.close(model.dialog)
	return {
		model: { ...model, dialog: step.model, isPending: false },
		commands: Command.mapMessages(step.commands ?? [], (message) =>
			Message.GotDialogMessage({ message }),
		),
	}
}

const addDraft = (model: Model): Model => {
	const draft = model.scopeDraft.value.trim()
	if (draft === "" || draftError(draft) !== undefined || model.scopePaths.length >= MAX_SCOPE_PATHS)
		return model
	return {
		...model,
		scopeDraft: Field.init(),
		scopePaths: model.scopePaths.includes(draft) ? model.scopePaths : [...model.scopePaths, draft],
	}
}

export const update = (
	model: Model,
	message: Message,
	repositories: ReadonlyArray<GithubRepoSummary>,
): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: inner }) => {
			// A create in flight keeps the dialog: the answer has a form to land in.
			if (model.isPending && DISMISSALS.has(inner._tag)) return { model }
			const step = Dialog.update(model.dialog, inner)
			return {
				model: { ...model, dialog: step.model },
				commands: Command.mapMessages(step.commands ?? [], (next) =>
					Message.GotDialogMessage({ message: next }),
				),
			}
		},
		GotRepositoryMessage: ({ message: inner }) => {
			const step = Select.update(model.repository, inner)
			const commands = Command.mapMessages(step.commands ?? [], (next) =>
				Message.GotRepositoryMessage({ message: next }),
			)
			const picked = step.outMessage
			if (picked === undefined) return { model: { ...model, repository: step.model }, commands }
			const repo = repositories.find((candidate) => candidate.fullName === picked.value)
			return {
				model: {
					...model,
					repository: { ...step.model, value: picked.value },
					branch: Field.init(repo === undefined ? model.branch.value : defaultBranch(repo)),
					failure: null,
				},
				commands,
			}
		},
		GotBranchMessage: ({ message: inner }) => ({
			model: {
				...model,
				branch: Field.update(model.branch, inner).model,
				failure: inner._tag === "ChangedValue" ? null : model.failure,
			},
		}),
		GotProfileMessage: ({ message: inner }) => {
			const step = RadioGroup.update(model.profile, inner)
			return {
				model: { ...model, profile: step.model },
				commands: Command.mapMessages(step.commands ?? [], (next) =>
					Message.GotProfileMessage({ message: next }),
				),
			}
		},
		GotScopeMessage: ({ message: inner }) => ({
			model: { ...model, scopeDraft: Field.update(model.scopeDraft, inner).model },
		}),
		AddedScopePath: () => ({ model: addDraft(model) }),
		RemovedScopePath: ({ path }) => ({
			model: { ...model, scopePaths: model.scopePaths.filter((candidate) => candidate !== path) },
		}),
		GotBudgetMessage: ({ message: inner }) => ({
			model: { ...model, budget: Field.update(model.budget, inner).model },
		}),
		ToggledStartNow: () => ({ model: { ...model, startNow: !model.startNow } }),
		Submitted: () => {
			if (model.isPending) return { model }
			const request = requestOf(model)
			if (request === null) return { model: { ...model, isSubmitted: true } }
			return {
				model: { ...addDraft(model), isSubmitted: true, isPending: true, failure: null },
				commands: [CreateSecurityTarget({ attempt: model.attempt, payload: request })],
			}
		},
		CompletedCreate: ({ attempt, result }) =>
			attempt !== model.attempt || !model.isPending
				? { model }
				: Result.match(result, {
						onFailure: (failure) => ({ model: { ...model, isPending: false, failure } }),
						onSuccess: (target) =>
							model.startNow
								? {
										model: { ...model, created: target },
										commands: [
											StartFirstRun({ attempt: model.attempt, targetId: target.id }),
										],
									}
								: { ...close(model), outMessage: OutMessage.Added({ target, run: null }) },
					}),
		CompletedStartFirstRun: ({ attempt, result }) => {
			const target = model.created
			if (target === null || attempt !== model.attempt) return { model }
			const closed = close({ ...model, created: null })
			return Result.match(result, {
				onSuccess: (run) => ({ ...closed, outMessage: OutMessage.Added({ target, run }) }),
				onFailure: (failure) => ({
					...closed,
					outMessage: OutMessage.AddedWithoutRun({ target, failure }),
				}),
			})
		},
	})
