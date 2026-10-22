import {
	type GithubIntegrationStatus,
	type GithubRepoSummary,
	PR_REVIEW_MODELS,
	PrReviewModel,
	PrReviewOrgSettings,
	PrReviewRepositoryConfig,
	type VcsRepositoryId,
} from "@maple/domain/http"
import { isClerkAuthEnabled } from "../../../lib/services/common/auth-mode"
import { currentRegion } from "../../../lib/region"
import { isUnexpectedError } from "@maple/web-data/lib/error-messages"
import { Option, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import type { LoadFailure } from "../../../data/load-failure"
import type { Resources } from "../../../platform/resources"
import { requestKey } from "../../../data/request-key"
import * as Dialog from "../../../ui/dialog"
import * as Select from "../../../ui/select"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { type Carried, noCarry } from "../kit/frame-update"
import { type Retained, retainedStatus } from "../kit/retained"
import * as RulesForm from "../rules-form/form"
import {
	FetchRepoConfig,
	FetchSettings,
	FetchStatus,
	ReadIsAdmin,
	SaveRepoConfig,
	SaveSettings,
	SetPrReview,
} from "./command"
import { Message, type Model, type SavePurpose } from "./model"
import { initRepoList, pinOnce } from "./repositories"

type Return = PageReturn<Model, Message>

export const DEFAULT_MODEL = "default"
export const DEFAULT_MODEL_LABEL = "Maple default"
/** The EU instance only serves models with an in-region provider. */
export const MODEL_OPTIONS = PR_REVIEW_MODELS.filter((model) => currentRegion !== "eu" || model.eu)
export const modelLabel = (value: string) =>
	value === DEFAULT_MODEL
		? DEFAULT_MODEL_LABEL
		: (MODEL_OPTIONS.find((model) => model.id === value)?.label ?? value)
const isModel = Schema.is(PrReviewModel)
// One instance, so the form's "the config changed" check does not fire on every answer.
const EMPTY_CONFIG = new PrReviewRepositoryConfig({})
export const DEFAULTS_FORM_ID = "code-review-defaults"

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

/** `errorMessage`: the failure's own message unless it is the generic one. */
const messageOf = (failure: LoadFailure, fallback: string) =>
	isUnexpectedError(failure) ? fallback : failure.message

const settingsKey = (context: PageContext) =>
	requestKey(context.orgId, "integrations.githubGetPrReviewSettings", {})
const statusKey = (context: PageContext) => requestKey(context.orgId, "integrations.githubStatus", {})
const configKey = (context: PageContext, repositoryId: VcsRepositoryId) =>
	requestKey(context.orgId, "integrations.githubGetPrReviewConfig", { params: { repositoryId } })

const settingsOf = (model: Model) =>
	Option.map(AsyncData.getData(model.settings.data), (response) => response.settings)

/** What every save is built from: this tab's writes over the server's settings. */
const baseSettings = (model: Model): PrReviewOrgSettings =>
	model.localSettings ?? Option.getOrElse(settingsOf(model), () => new PrReviewOrgSettings({}))

const withModel = (settings: PrReviewOrgSettings, picked: PrReviewModel | undefined) =>
	new PrReviewOrgSettings({
		...(picked === undefined ? undefined : { model: picked }),
		...(settings.defaults === undefined ? undefined : { defaults: settings.defaults }),
	})

const withDefaults = (settings: PrReviewOrgSettings, defaults: PrReviewRepositoryConfig | undefined) =>
	new PrReviewOrgSettings({
		...(settings.model === undefined ? undefined : { model: settings.model }),
		...(defaults === undefined ? undefined : { defaults }),
	})

/** Records `settings` as this tab's and writes it now, or after the save in flight. */
const enqueueSave = (
	model: Model,
	purpose: SavePurpose,
	label: string,
	settings: PrReviewOrgSettings,
): Return => {
	const next: Model = { ...model, localSettings: settings }
	return model.savingSettings === null
		? {
				model: { ...next, savingSettings: purpose, sentSettings: settings },
				commands: [SaveSettings({ purpose, label, settings })],
			}
		: {
				model: {
					...next,
					queuedSaves: [
						...model.queuedSaves.filter((queued) => queued.purpose !== purpose),
						{ purpose, label },
					],
				},
			}
}

/**
 * A settings save settled: a failed field goes back to the last confirmed value, the next queued
 * save is sent with everything this tab wrote, and once none is left the settings are read again.
 */
const settleSave = (model: Model, context: PageContext, purpose: SavePurpose, isFailure: boolean): Return => {
	const read = Option.getOrElse(settingsOf(model), () => new PrReviewOrgSettings({}))
	const confirmed = isFailure ? (model.confirmedSettings ?? read) : (model.sentSettings ?? read)
	const local = baseSettings(model)
	const kept = !isFailure
		? local
		: purpose === "model"
			? withModel(local, confirmed.model)
			: withDefaults(local, confirmed.defaults)
	const [head, ...rest] = model.queuedSaves
	return head === undefined
		? readSettings(
				{
					...model,
					localSettings: kept,
					savingSettings: null,
					sentSettings: null,
					confirmedSettings: confirmed,
				},
				context,
				"Supersede",
			)
		: {
				model: {
					...model,
					localSettings: kept,
					savingSettings: head.purpose,
					queuedSaves: rest,
					sentSettings: kept,
					confirmedSettings: confirmed,
				},
				commands: [SaveSettings({ purpose: head.purpose, label: head.label, settings: kept })],
			}
}

export const currentModel = (settings: PrReviewOrgSettings) =>
	settings.model !== undefined && MODEL_OPTIONS.some((model) => model.id === settings.model)
		? settings.model
		: DEFAULT_MODEL

/** Reads `slot` under `key` in `mode`; `Some` is the slot and its fetch. */
const read = <A>(
	slot: Keyed.Keyed<A, LoadFailure>,
	key: string,
	mode: Keyed.ReadMode,
	fetch: (key: string) => Command.Command<Message, never, Resources>,
) =>
	Option.match(Keyed.requestFor(slot, key, mode), {
		onNone: () => ({ slot, commands: [] }),
		onSome: (next) => ({ slot: next, commands: [fetch(next.key)] }),
	})

const readSettings = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	const step = read(model.settings, settingsKey(context), mode, (key) => FetchSettings({ key }))
	return { model: { ...model, settings: step.slot }, commands: step.commands }
}

const readStatus = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	const step = read(model.githubStatus, statusKey(context), mode, (key) => FetchStatus({ key }))
	return { model: { ...model, githubStatus: step.slot }, commands: step.commands }
}

const readConfig = (
	model: Model,
	context: PageContext,
	repositoryId: VcsRepositoryId,
	mode: Keyed.ReadMode,
): Return => {
	const step = read(model.repoConfig, configKey(context, repositoryId), mode, (key) =>
		FetchRepoConfig({ key, repositoryId }),
	)
	return { model: { ...model, repoConfig: step.slot }, commands: step.commands }
}

/** The installation's active repositories, as the server has them. */
export const activeRepositories = (model: Model): ReadonlyArray<GithubRepoSummary> =>
	Option.match(AsyncData.getData(model.githubStatus.data), {
		onNone: () => [],
		onSome: (status) => status.repositories.filter((repo) => repo.status === "active"),
	})

/** A row's switch: the optimistic value while one is held, else the server's. */
export const isRepoEnabled = (model: Model, repo: GithubRepoSummary): boolean =>
	model.optimistic[repo.id]?.isEnabled ?? repo.prReviewEnabled

/** The server's `prReviewEnabled` for a repository in a status slot. */
const serverValueOf = (
	data: AsyncData.AsyncData<GithubIntegrationStatus, LoadFailure>,
	repositoryId: string,
): boolean | undefined =>
	Option.getOrUndefined(AsyncData.getData(data))?.repositories.find((repo) => repo.id === repositoryId)
		?.prReviewEnabled

const combine = (first: Return, second: (model: Model) => Return): Return => {
	const next = second(first.model)
	return {
		...next,
		commands: [...(first.commands ?? []), ...(next.commands ?? [])],
		outMessage: next.outMessage ?? first.outMessage,
	}
}

// ENTRY

export const init = (_route: unknown, context: PageContext, carried: Carried = noCarry): Return => {
	const key = statusKey(context)
	const model: Model = {
		settings: Keyed.idle(),
		githubStatus: Option.match(retainedStatus(carried.retained, key, carried.nowMs), {
			onNone: () => Keyed.idle(),
			onSome: (status) => ({ key, data: AsyncData.Success({ data: status }) }),
		}),
		isAdmin: !isClerkAuthEnabled,
		modelSelect: Select.init("code-review-model", { value: DEFAULT_MODEL, selectedIndex: null }),
		isSavingModel: false,
		localSettings: null,
		savingSettings: null,
		sentSettings: null,
		confirmedSettings: null,
		queuedSaves: [],
		defaultsForm: null,
		repoList: initRepoList(),
		optimistic: {},
		busy: [],
		dialog: Dialog.init("code-review-repo-rules", "dialog"),
		configuring: null,
		repoConfig: Keyed.idle(),
		repoForm: null,
	}
	// Pins on mount from whatever status it has, a handed-over one included.
	const pinned: Model = AsyncData.isSuccess(model.githubStatus.data)
		? { ...model, repoList: pinOnce(model.repoList, activeRepositories(model)) }
		: model
	return combine(readSettings(pinned, context, "Load"), (next) => ({
		model: next,
		commands: isClerkAuthEnabled ? [ReadIsAdmin()] : [],
	}))
}

const liftForm = (
	model: Model,
	which: "defaults" | "repo",
	result: ReturnType<typeof RulesForm.update>,
): Return => {
	const wrap = (message: RulesForm.Message) =>
		which === "defaults"
			? Message.GotDefaultsFormMessage({ message })
			: Message.GotRepoFormMessage({ message })
	const next: Model =
		which === "defaults" ? { ...model, defaultsForm: result.model } : { ...model, repoForm: result.model }
	const commands = Command.mapMessages(result.commands ?? [], wrap)
	const saved = result.outMessage
	if (saved === undefined) return { model: next, commands }
	if (which === "defaults") {
		const queued = enqueueSave(next, "defaults", "", withDefaults(baseSettings(model), saved.config))
		return { ...queued, commands: [...commands, ...(queued.commands ?? [])] }
	}
	const repo = activeRepositories(model).find((candidate) => candidate.id === model.configuring)
	return repo === undefined
		? { model: next, commands }
		: {
				model: next,
				commands: [
					...commands,
					SaveRepoConfig({ repositoryId: repo.id, fullName: repo.fullName, config: saved.config }),
				],
			}
}

/** A settings answer: the model select and the default rules follow it. */
const settingsArrived = (model: Model): Model =>
	Option.match(settingsOf(model), {
		onNone: () => model,
		onSome: (settings) => {
			const defaults = settings.defaults ?? EMPTY_CONFIG
			return {
				...model,
				modelSelect: { ...model.modelSelect, value: currentModel(settings) },
				defaultsForm:
					model.defaultsForm === null
						? RulesForm.init(DEFAULTS_FORM_ID, "organization", defaults, null)
						: RulesForm.syncConfig(model.defaultsForm, defaults),
				repoForm:
					model.repoForm === null
						? null
						: { ...model.repoForm, inherited: settings.defaults ?? null },
			}
		},
	})

const liftDialog = (model: Model, result: ReturnType<typeof Dialog.update>): Return => {
	const commands = Command.mapMessages(result.commands ?? [], (message) =>
		Message.GotDialogMessage({ message }),
	)
	// `RepositoryConfig` unmounts with the closed dialog: the next open builds its form again.
	const closed = result.outMessage?._tag === "Closed"
	return {
		model: { ...model, dialog: result.model, repoForm: closed ? null : model.repoForm },
		commands,
	}
}

/** `RepositoryConfig`'s form, built from the answer once it is in (or kept in step with it). */
const withRepoForm = (model: Model): Model =>
	Option.match(AsyncData.getData(model.repoConfig.data), {
		onNone: () => model,
		onSome: (response) => ({
			...model,
			repoForm:
				model.repoForm === null
					? RulesForm.init(
							`code-review-${model.configuring ?? ""}`,
							"repository",
							response.config,
							Option.getOrNull(
								Option.flatMap(settingsOf(model), (s) => Option.fromNullishOr(s.defaults)),
							),
						)
					: RulesForm.syncConfig(model.repoForm, response.config),
		}),
	})

const pickModel = (model: Model, value: string): Return =>
	Option.match(settingsOf(model), {
		onNone: () => ({ model }),
		onSome: (settings) => {
			// Controlled by the saved value: the trigger shows it until the refetch says otherwise.
			const reverted = {
				...model,
				modelSelect: { ...model.modelSelect, value: currentModel(settings) },
			}
			if (value === currentModel(baseSettings(model)) || model.isSavingModel || !model.isAdmin)
				return { model: reverted }
			const picked = isModel(value) ? value : undefined
			return enqueueSave(
				{ ...reverted, isSavingModel: true },
				"model",
				modelLabel(picked ?? DEFAULT_MODEL),
				withModel(baseSettings(model), picked),
			)
		},
	})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchSettings: ({ key, result }) => {
			const settings = Keyed.accept(model.settings, key, result)
			// The server has caught up with this tab's writes once none is in flight.
			const isSettled =
				settings !== model.settings &&
				model.savingSettings === null &&
				AsyncData.isSuccess(settings.data)
			const next = settingsArrived({
				...model,
				settings,
				localSettings: isSettled ? null : model.localSettings,
				confirmedSettings: isSettled ? null : model.confirmedSettings,
			})
			// `RepositoriesSection` mounts with the settings: the repositories are read then.
			return Option.isSome(settingsOf(next)) && AsyncData.isIdle(next.githubStatus.data)
				? readStatus(next, context, "Load")
				: { model: next }
		},
		CompletedFetchStatus: ({ key, result }) => {
			const githubStatus = Keyed.accept(model.githubStatus, key, result)
			const next: Model = {
				...model,
				githubStatus,
				optimistic: Object.fromEntries(
					Object.entries(model.optimistic).filter(
						([id, entry]) => serverValueOf(githubStatus.data, id) === entry.server,
					),
				),
			}
			return { model: { ...next, repoList: pinOnce(next.repoList, activeRepositories(next)) } }
		},
		CompletedFetchRepoConfig: ({ key, result }) =>
			model.repoConfig.key === key
				? {
						model: withRepoForm({
							...model,
							repoConfig: Keyed.accept(model.repoConfig, key, result),
						}),
					}
				: { model },
		CompletedReadIsAdmin: ({ isAdmin }) => ({ model: { ...model, isAdmin } }),
		ClickedRetrySettings: () => readSettings(model, context, "Refresh"),
		ClickedRetryStatus: () => readStatus(model, context, "Refresh"),
		GotModelSelectMessage: ({ message: inner }) => {
			const next = Select.update(model.modelSelect, inner)
			const lifted: Return = {
				model: { ...model, modelSelect: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotModelSelectMessage({ message: m }),
				),
			}
			return next.outMessage === undefined
				? lifted
				: combine(lifted, (current) => pickModel(current, next.outMessage?.value ?? DEFAULT_MODEL))
		},
		CompletedSaveSettings: ({ purpose, label, result }) => {
			const failure = result._tag === "Failure" ? Option.some(result.failure) : Option.none()
			const refetch = (next: Model): Return =>
				settleSave(next, context, purpose, Option.isSome(failure))
			if (purpose === "model") {
				const saved = refetch({ ...model, isSavingModel: false })
				return {
					...saved,
					outMessage: Option.match(failure, {
						onNone: () => toast("success", `Reviews now run on ${label}`),
						onSome: (error) => toast("error", "Failed to save the review model.", error.message),
					}),
				}
			}
			const form = model.defaultsForm
			const next: Model = {
				...model,
				defaultsForm:
					form === null
						? null
						: RulesForm.completeSave(
								form,
								Option.map(failure, (error) =>
									messageOf(error, "Failed to save the default rules."),
								),
							),
			}
			const saved = refetch(next)
			return Option.isNone(failure)
				? { ...saved, outMessage: toast("success", "Default review rules saved") }
				: saved
		},
		GotDefaultsFormMessage: ({ message: inner }) =>
			model.defaultsForm === null
				? { model }
				: liftForm(model, "defaults", RulesForm.update(model.defaultsForm, inner)),
		ChangedRepoSearch: ({ value }) => ({
			model: { ...model, repoList: { ...model.repoList, search: value } },
		}),
		PickedRepoFilter: ({ filter }) => ({ model: { ...model, repoList: { ...model.repoList, filter } } }),
		ClickedShowAllRepos: () => ({
			model: { ...model, repoList: { ...model.repoList, search: "", filter: "all" } },
		}),
		ToggledRepo: ({ repositoryId, fullName, isEnabled }) =>
			model.busy.includes(repositoryId) || !model.isAdmin
				? { model }
				: {
						model: {
							...model,
							optimistic: {
								...model.optimistic,
								[repositoryId]: {
									isEnabled,
									server:
										serverValueOf(model.githubStatus.data, repositoryId) ?? !isEnabled,
								},
							},
							busy: [...model.busy, repositoryId],
						},
						commands: [SetPrReview({ repositoryId, fullName, isEnabled })],
					},
		CompletedSetPrReview: ({ repositoryId, fullName, isEnabled, result }) => {
			const busy = model.busy.filter((id) => id !== repositoryId)
			if (result._tag === "Failure")
				return {
					model: {
						...model,
						busy,
						optimistic: Object.fromEntries(
							Object.entries(model.optimistic).filter(([id]) => id !== repositoryId),
						),
					},
					outMessage: toast(
						"error",
						"Failed to change pull request reviews.",
						result.failure.message,
					),
				}
			return {
				...readStatus({ ...model, busy }, context, "Supersede"),
				outMessage: toast(
					"success",
					isEnabled
						? `Maple will review pull requests on ${fullName}`
						: `Reviews off for ${fullName}`,
				),
			}
		},
		ClickedConfigure: ({ repositoryId }) => {
			const isSameRepo = model.configuring === repositoryId
			const base: Model = {
				...model,
				configuring: repositoryId,
				repoForm: null,
				repoConfig: isSameRepo ? model.repoConfig : Keyed.idle(),
			}
			return combine(liftDialog(base, Dialog.open(model.dialog)), (next) => {
				const read = readConfig(next, context, repositoryId, "Load")
				return { ...read, model: withRepoForm(read.model) }
			})
		},
		GotDialogMessage: ({ message: inner }) => liftDialog(model, Dialog.update(model.dialog, inner)),
		GotRepoFormMessage: ({ message: inner }) =>
			model.repoForm === null
				? { model }
				: liftForm(model, "repo", RulesForm.update(model.repoForm, inner)),
		CompletedSaveRepoConfig: ({ repositoryId, fullName, result }) => {
			const failure = result._tag === "Failure" ? Option.some(result.failure) : Option.none()
			// Per-row dialog: another repository's form only gets the success toast.
			if (model.configuring !== repositoryId)
				return Option.isSome(failure)
					? { model }
					: { model, outMessage: toast("success", `Rules saved for ${fullName}`) }
			const form = model.repoForm
			const next: Model = {
				...model,
				repoForm:
					form === null
						? null
						: RulesForm.completeSave(
								form,
								Option.map(failure, (error) =>
									messageOf(error, "Failed to save the repository's rules."),
								),
							),
			}
			if (Option.isSome(failure)) return { model: next }
			return {
				...readConfig(next, context, repositoryId, "Supersede"),
				outMessage: toast("success", `Rules saved for ${fullName}`),
			}
		},
	})

/** What this tab hands the next one: the GitHub status, with no clock of its own to stamp it. */
export const retainedOf = (model: Model, nowMs: number): Partial<Retained> => {
	const key = model.githubStatus.key
	if (key === null) return {}
	return Option.match(AsyncData.getData(model.githubStatus.data), {
		onNone: () => ({}),
		// Stored under the plain key: a post-write re-read's key carries a generation.
		onSome: (status) => ({ githubStatus: { [Keyed.baseKey(key)]: { value: status, usedAtMs: nowMs } } }),
	})
}
