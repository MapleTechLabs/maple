import type { V2Source } from "@maple/domain/http/v2"
import { Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import type { LoadFailure } from "../../../data/load-failure"
import { AppRoute, hrefOf } from "../../../route"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { copyToast } from "../../kit/clipboard"
import { sourcesListKey, sourceUsageKey } from "../kit/data"
import * as Rules from "../kit/rules"
import * as Setup from "../kit/setup"
import { hasOwnRemoval } from "../kit/integration"
import {
	effectiveTab,
	focusIdOf,
	fromPublicSourceId,
	hasToken,
	integrationPlatformOf,
	scrapeTargetIdOf,
} from "../kit/shared"
import { initEmbedded } from "../../integrations/embed"
import * as Integrations from "../../integrations/update"
import { connectionsOf as awsConnectionsOf } from "../../integrations/update-aws"
import { gcpConnectors } from "../../integrations/update-gcp"
import { Message as IntegrationMessage } from "../../integrations/message"
import type { Model as IntegrationModel } from "../../integrations/model"
import {
	DeleteSource,
	FetchSourceList,
	FetchSourceUsage,
	PauseSource,
	ReadSourceClock,
	ResumeSource,
	RollSourceToken,
	SaveSource,
} from "./command"
import { Message } from "./message"
import type { Model, SettingsForm } from "./model"

type Return = PageReturn<Model, Message>
type SourceRoute = Extract<AppRoute, { readonly _tag: "Source" }>

export const PAUSE_MENU_ID = "source-pause-menu"
/** `PAUSE_CHOICES`, keyed by the menu item value. */
export const PAUSE_CHOICES = [
	{ value: "1h", label: "For 1 hour", hours: 1 },
	{ value: "24h", label: "For 24 hours", hours: 24 },
	{ value: "resumed", label: "Until resumed", hours: null },
] as const

/** `useSource`: the route's source from the shared list, once it has loaded. */
export const sourceOf = (model: Model): Option.Option<V2Source> =>
	Option.flatMap(AsyncData.getData(model.list.data), (rows) =>
		Option.fromUndefinedOr(rows.find((row) => row.id === model.sourceId)),
	)

const loadList = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	if (model.sourceId === null) return { model }
	return Option.match(Keyed.requestFor(model.list, sourcesListKey(context.orgId), mode), {
		onNone: () => ({ model }),
		onSome: (list) => ({
			model: { ...model, list },
			commands: [FetchSourceList({ key: list.key, refresh: mode !== "Load" })],
		}),
	})
}

/** `SourceOverview` reads the usage as it mounts: the overview tab over a found source. */
const loadUsage = (model: Model, context: PageContext): Return => {
	const source = sourceOf(model)
	if (model.tab !== "overview" || Option.isNone(source)) return { model }
	const id = source.value.id
	const key = sourceUsageKey(context.orgId, id)
	return Option.match(Keyed.request(model.usage, key, "Load"), {
		onNone: () => ({ model }),
		onSome: (usage) => ({ model: { ...model, usage }, commands: [FetchSourceUsage({ key, id })] }),
	})
}

const settingsOf = (source: V2Source): SettingsForm => ({
	builtFrom: source.updated_at,
	name: source.name,
	description: source.description ?? "",
	rules: Rules.init(source),
	isSaving: false,
})

/** The form differs from the source it was built from: the save bar shows. */
export const isSettingsDirty = (form: SettingsForm): boolean => {
	const base = form.rules.existing
	if (base === null) return false
	return (
		form.name !== base.name ||
		form.description !== (base.description ?? "") ||
		(hasToken(base) && Rules.isRulesDirty(form.rules))
	)
}

/** The open tab's state, built as its component mounts; Settings rebuilds when `updated_at` moves. */
const withTabState = (model: Model): Model =>
	Option.match(sourceOf(model), {
		onNone: () => model,
		onSome: (source) => withSourceTab({ ...model, tab: effectiveTab(source, model.tab) }, source),
	})

const withSourceTab = (model: Model, source: V2Source): Model => ({
	...model,
	setup: model.tab !== "setup" ? null : (model.setup ?? Setup.init(source.platform)),
	settings:
		model.tab !== "settings"
			? null
			: model.settings !== null && model.settings.builtFrom === source.updated_at
				? model.settings
				: settingsOf(source),
})

const andThen = (first: Return, next: (model: Model) => Return): Return => {
	const second = next(first.model)
	const merged: Return = { ...second, commands: [...(first.commands ?? []), ...(second.commands ?? [])] }
	const outMessage = second.outMessage ?? first.outMessage
	return outMessage === undefined ? merged : { ...merged, outMessage }
}

/** The embedded integration's step, lifted: its Commands answer as `GotConnectionMessage`. */
const liftConnection = (model: Model, step: PageReturn<IntegrationModel, IntegrationMessage>): Return => {
	const lifted: Return = {
		model: { ...model, connection: step.model },
		commands: Command.mapMessages(step.commands ?? [], (message) =>
			Message.GotConnectionMessage({ message }),
		),
	}
	return step.outMessage === undefined ? lifted : { ...lifted, outMessage: step.outMessage }
}

/** An integration source builds its integration once the source is known: the card, header and reads. */
const ensureConnection = (model: Model, context: PageContext): Return => {
	if (model.connection !== null) return { model }
	const source = Option.getOrNull(sourceOf(model))
	const platform = source === null ? null : integrationPlatformOf(source)
	if (source === null || platform === null) return { model }
	return andThen(liftConnection(model, initEmbedded(platform, context)), (next) =>
		syncTarget(next, context),
	)
}

/**
 * A Prometheus source's own target is selected while Connection shows (its scheduled checks
 * open without a click) and let go on other tabs, so the checks stop polling.
 */
const syncTarget = (model: Model, context: PageContext): Return => {
	const connection = model.connection
	const target = Option.match(sourceOf(model), { onNone: () => null, onSome: scrapeTargetIdOf })
	if (connection === null || target === null) return { model }
	const selected = connection.prometheusCard.selectedId
	if (model.tab !== "connection")
		return selected === null
			? { model }
			: {
					model: {
						...model,
						connection: {
							...connection,
							prometheusCard: { ...connection.prometheusCard, selectedId: null },
						},
					},
				}
	return selected === target
		? { model }
		: liftConnection(
				model,
				Integrations.update(connection, IntegrationMessage.ClickedTarget({ id: target }), context),
			)
}

export const init = (route: SourceRoute, context: PageContext): Return => {
	const model: Model = {
		sourceId: Option.getOrNull(fromPublicSourceId(route.sourceId)),
		tab: route.search.tab ?? "overview",
		nowMs: null,
		list: Keyed.idle(),
		usage: Keyed.idle(),
		revealed: null,
		busy: null,
		pauseMenu: Menu.init(PAUSE_MENU_ID),
		rollDialog: Dialog.init("source-roll-dialog", "alert-dialog"),
		deleteDialog: Dialog.init("source-delete-dialog", "alert-dialog"),
		tokenCopy: CopyButton.init(),
		chart: Chart.init(),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		setup: null,
		settings: null,
		connection: null,
	}
	const runtime = Command.mapMessage(LoadChartRuntime(), (message) =>
		message._tag === "CompletedLoadChartRuntime"
			? Message.CompletedLoadChartRuntime()
			: Message.FailedLoadChartRuntime({ reason: message.reason }),
	)
	const loaded = loadList(model, context, "Load")
	return { model: loaded.model, commands: [ReadSourceClock(), runtime, ...(loaded.commands ?? [])] }
}

/** A tab link keeps the instance: the overview reads its usage again when it shows. */
export const routeChanged = (model: Model, route: SourceRoute, context: PageContext): Return =>
	andThen(
		loadUsage(
			withTabState({ ...model, tab: route.search.tab ?? "overview", setup: null, settings: null }),
			context,
		),
		(next) => syncTarget(next, context),
	)

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const failureToast = (title: string, failure: LoadFailure) => toast("error", title, failure.message)

const SOURCES_HREF = hrefOf(AppRoute.Sources())

const liftMenu = (model: Model, step: ReturnType<typeof Menu.update>): Return => {
	const lifted: Return = {
		model: { ...model, pauseMenu: step.model },
		commands: Command.mapMessages(step.commands ?? [], (message) =>
			Message.GotPauseMenuMessage({ message }),
		),
	}
	const picked = step.outMessage?._tag === "SelectedItem" ? step.outMessage.value : null
	const choice = PAUSE_CHOICES.find((entry) => entry.value === picked)
	if (choice === undefined || model.sourceId === null || model.busy !== null) return lifted
	return {
		...lifted,
		model: { ...lifted.model, busy: "pause" },
		commands: [...(lifted.commands ?? []), PauseSource({ id: model.sourceId, hours: choice.hours })],
	}
}

const liftDialog = (
	model: Model,
	field: "rollDialog" | "deleteDialog",
	step: ReturnType<typeof Dialog.update>,
): Return => ({
	model: { ...model, [field]: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		field === "rollDialog"
			? Message.GotRollDialogMessage({ message })
			: Message.GotDeleteDialogMessage({ message }),
	),
})

/** A write settled: refresh the list on success (`useAtomRefresh(sourcesListAtom)`), toast either way. */
const settled = <A>(
	model: Model,
	context: PageContext,
	result: Result.Result<A, LoadFailure>,
	copy: Readonly<{ success: string; error: string }>,
): Return =>
	Result.match(result, {
		onFailure: (failure) => ({
			model: { ...model, busy: null },
			outMessage: failureToast(copy.error, failure),
		}),
		onSuccess: () => ({
			...loadList({ ...model, busy: null }, context, "Supersede"),
			outMessage: toast("success", copy.success),
		}),
	})

const withSource = (model: Model, run: (id: NonNullable<Model["sourceId"]>) => Return): Return =>
	model.sourceId === null || model.busy !== null ? { model } : run(model.sourceId)

const withSettings = (model: Model, write: (form: SettingsForm) => SettingsForm): Model =>
	model.settings === null ? model : { ...model, settings: write(model.settings) }

/** `SourceSettings`' save: basics for the default source and integrations, rules for token sources. */
const save = (model: Model): Return => {
	const source = sourceOf(model)
	const form = model.settings
	if (Option.isNone(source) || form === null || form.isSaving) return { model }
	const outcome = Rules.rulesOutcome(form.rules)
	const name = form.name.trim()
	const isToken = hasToken(source.value)
	if (name.length === 0 || (isToken && !outcome.valid)) return { model }
	const description = form.description.trim()
	const basics = { name, description: description.length > 0 ? description : null }
	return {
		model: withSettings(model, (current) => ({ ...current, isSaving: true })),
		commands: [
			SaveSource({
				id: source.value.id,
				payload: isToken ? { ...basics, ...outcome.payload } : basics,
				expiry: isToken ? form.rules.expiry : null,
			}),
		],
	}
}

/** Google Cloud's integration page keeps a removed connection's cleanup script. */
const GCP_CLEANUP_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "gcp" } }))

/** The source is gone: leave for `url`, keeping the write's toast or saying it was deleted. */
const leaveFor = (step: Return, url: string): Return => {
	const toast =
		step.outMessage?._tag === "RequestedToast"
			? step.outMessage
			: { type: "success" as const, title: "Source deleted", description: "" }
	return {
		...step,
		outMessage: PageOutMessage.RequestedNavigation({
			url,
			isReplace: true,
			toast: { type: toast.type, title: toast.title, description: toast.description },
		}),
	}
}

/**
/** The AWS integration page keeps a removed connection's cleanup script. */
const AWS_CLEANUP_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "aws" } }))

/**
 * A write in the Connection tab changes this source too: removing what it stands for (its own
 * target or connection, or the whole integration) deletes the source, so the page leaves for the
 * list; a toggle, edit or check re-reads it so the header follows.
 */
const afterConnectionWrite = (
	model: Model,
	child: IntegrationMessage,
	step: Return,
	context: PageContext,
): Return => {
	// An AWS check rewrites the source's health; a background one only matters once it verifies. A
	// click during a background check makes it the user's, which only the card's model knows.
	const isAwsCheck =
		child._tag === "CompletedAwsCheck" &&
		(child.connection?.verified_at != null ||
			!(
				model.connection?.awsCard.checking.find((entry) => entry.id === child.id)?.quiet ??
				child.quiet
			))
	const isAwsDisconnect = child._tag === "CompletedAwsDisconnect" && child.removed !== null
	const isWrite =
		child._tag === "CompletedTargetDelete" ||
		child._tag === "CompletedToggle" ||
		child._tag === "CompletedSave" ||
		child._tag === "CompletedDisconnect" ||
		child._tag === "CompletedGcpDisconnect" ||
		isAwsCheck ||
		isAwsDisconnect
	if (!isWrite || ("failure" in child && child.failure !== null)) return step
	const source = Option.getOrNull(sourceOf(model))
	const focus = source === null ? null : focusIdOf(source)
	const isGone =
		(child._tag === "CompletedDisconnect" &&
			// A multi-account Cloudflare grant disconnects as "cloudflare-multi".
			(child.integration === source?.platform ||
				(source?.platform === "cloudflare" && child.integration === "cloudflare-multi"))) ||
		((child._tag === "CompletedTargetDelete" ||
			child._tag === "CompletedGcpDisconnect" ||
			child._tag === "CompletedAwsDisconnect") &&
			child.id === focus)
	if (!isGone)
		// The re-read can be newer than the page clock: read it again so "ago" stays in the past.
		return andThen(step, (next) => {
			const reloaded = loadList(next, context, "Supersede")
			return { ...reloaded, commands: [ReadSourceClock(), ...(reloaded.commands ?? [])] }
		})
	if (child._tag === "CompletedGcpDisconnect") return leaveFor(step, GCP_CLEANUP_HREF)
	if (child._tag === "CompletedAwsDisconnect") return leaveFor(step, AWS_CLEANUP_HREF)
	return leaveFor(step, SOURCES_HREF)
}

/** Google Cloud and AWS remove through their own dialog (cleanup script first); the rest confirm here. */
const clickedDelete = (model: Model, context: PageContext): Return => {
	const source = Option.getOrNull(sourceOf(model))
	const focus = source === null ? null : focusIdOf(source)
	// A source whose connector is already gone has nothing to clean up: the generic dialog deletes it.
	if (source === null || !hasOwnRemoval(source) || focus === null)
		return liftDialog(model, "deleteDialog", Dialog.open(model.deleteDialog))
	if (source.platform === "aws") {
		const connection =
			model.connection === null
				? undefined
				: awsConnectionsOf(model.connection).find((entry) => entry.id === focus)
		if (model.connection === null || connection === undefined)
			return {
				model,
				outMessage: toast("error", "Couldn't load the AWS connection", "Try again in a moment."),
			}
		return liftConnection(
			model,
			Integrations.update(
				model.connection,
				IntegrationMessage.ClickedAwsDisconnect({ id: connection.id }),
				context,
			),
		)
	}
	const connector =
		model.connection === null
			? undefined
			: gcpConnectors(model.connection).find((entry) => entry.id === focus)
	if (model.connection === null || connector === undefined)
		return {
			model,
			outMessage: toast("error", "Couldn't load the Google Cloud connection", "Try again in a moment."),
		}
	return liftConnection(
		model,
		Integrations.update(
			model.connection,
			IntegrationMessage.ClickedGcpDisconnect({ id: focus }),
			context,
		),
	)
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchList: ({ key, result }) =>
			andThen(
				loadUsage(withTabState({ ...model, list: Keyed.accept(model.list, key, result) }), context),
				(next) => ensureConnection(next, context),
			),
		GotConnectionMessage: ({ message: child }) =>
			model.connection === null
				? { model }
				: afterConnectionWrite(
						model,
						child,
						liftConnection(model, Integrations.update(model.connection, child, context)),
						context,
					),
		CompletedFetchUsage: ({ key, result }) => ({
			model: { ...model, usage: Keyed.accept(model.usage, key, result) },
		}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		GotChartMessage: ({ message: inner }) => {
			const next = Chart.update(model.chart, inner)
			return {
				model: { ...model, chart: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotChartMessage({ message: m }),
				),
			}
		},
		GotPauseMenuMessage: ({ message: inner }) => liftMenu(model, Menu.update(model.pauseMenu, inner)),
		ClickedResume: () =>
			withSource(model, (id) => ({
				model: { ...model, busy: "resume" },
				commands: [ResumeSource({ id })],
			})),
		ClickedRollToken: () => liftDialog(model, "rollDialog", Dialog.open(model.rollDialog)),
		ClickedDelete: () => clickedDelete(model, context),
		ClickedPauseUntilResumed: () =>
			withSource(model, (id) => {
				const closed = liftDialog(model, "deleteDialog", Dialog.close(model.deleteDialog))
				return {
					...closed,
					model: { ...closed.model, busy: "pause" },
					commands: [...(closed.commands ?? []), PauseSource({ id, hours: null })],
				}
			}),
		// A pending dialog ignores Escape and Cancel (`onOpenChange` while `pending`).
		GotRollDialogMessage: ({ message: inner }) =>
			model.busy === "roll"
				? { model }
				: liftDialog(model, "rollDialog", Dialog.update(model.rollDialog, inner)),
		GotDeleteDialogMessage: ({ message: inner }) =>
			model.busy === "delete"
				? { model }
				: liftDialog(model, "deleteDialog", Dialog.update(model.deleteDialog, inner)),
		ConfirmedRoll: () =>
			withSource(model, (id) => ({
				model: { ...model, busy: "roll" },
				commands: [RollSourceToken({ id })],
			})),
		ConfirmedDelete: () =>
			withSource(model, (id) => ({
				model: { ...model, busy: "delete" },
				commands: [DeleteSource({ id })],
			})),
		CompletedPause: ({ result }) =>
			settled(model, context, result, {
				success: "Source paused. Takes effect within a minute.",
				error: "Couldn't pause source",
			}),
		CompletedResume: ({ result }) =>
			settled(model, context, result, {
				success: "Source resumed. Takes effect within a minute.",
				error: "Couldn't resume source",
			}),
		CompletedRoll: ({ result }) => {
			const closed = liftDialog({ ...model, busy: null }, "rollDialog", Dialog.close(model.rollDialog))
			return Result.match(result, {
				onFailure: (failure) => ({
					...closed,
					outMessage: failureToast("Couldn't roll token", failure),
				}),
				onSuccess: (rolled) =>
					andThen(closed, (next) =>
						loadList(
							{
								...next,
								revealed: { sourceId: rolled.id, secret: rolled.secret, rolled: true },
							},
							context,
							"Supersede",
						),
					),
			})
		},
		CompletedDelete: ({ result }) =>
			Result.match(result, {
				onFailure: (failure) => ({
					model: { ...model, busy: null },
					outMessage: failureToast("Couldn't delete source", failure),
				}),
				onSuccess: () => {
					const closed = liftDialog(
						{ ...model, busy: null },
						"deleteDialog",
						Dialog.close(model.deleteDialog),
					)
					const refreshed = andThen(closed, (next) => loadList(next, context, "Supersede"))
					return {
						...refreshed,
						outMessage: PageOutMessage.RequestedNavigation({
							url: SOURCES_HREF,
							isReplace: false,
							toast: { type: "success", title: "Source deleted", description: "" },
						}),
					}
				},
			}),
		GotSetupMessage: ({ message: inner }) => {
			if (model.setup === null) return { model }
			const step = Setup.update(model.setup, inner)
			return {
				model: { ...model, setup: step.model },
				commands: Command.mapMessages(step.commands ?? [], (m) =>
					Message.GotSetupMessage({ message: m }),
				),
			}
		},
		GotRulesMessage: ({ message: inner }) => {
			if (model.settings === null) return { model }
			const step = Rules.update(model.settings.rules, inner)
			return {
				model: withSettings(model, (form) => ({ ...form, rules: step.model })),
				commands: Command.mapMessages(step.commands ?? [], (m) =>
					Message.GotRulesMessage({ message: m }),
				),
			}
		},
		ChangedSettingsName: ({ value }) => ({
			model: withSettings(model, (form) => ({ ...form, name: value })),
		}),
		ChangedSettingsDescription: ({ value }) => ({
			model: withSettings(model, (form) => ({ ...form, description: value })),
		}),
		SubmittedSettings: () => save(model),
		ClickedDiscardSettings: () =>
			model.settings === null || model.settings.isSaving
				? { model }
				: Option.match(sourceOf(model), {
						onNone: () => ({ model }),
						onSome: (source) => ({ model: { ...model, settings: settingsOf(source) } }),
					}),
		CompletedSave: ({ result }) =>
			settled(
				// Rebuilt from the saved source, so the form is clean before the list reload lands.
				Result.match(result, {
					onFailure: () => withSettings(model, (form) => ({ ...form, isSaving: false })),
					onSuccess: (saved) =>
						model.settings === null ? model : { ...model, settings: settingsOf(saved) },
				}),
				context,
				result,
				{
					success: "Source saved. Changes reach the gateway within a minute.",
					error: "Couldn't save source",
				},
			),
		GotTokenCopyMessage: ({ message: inner }) => {
			const next = CopyButton.update(model.tokenCopy, inner)
			// `CopyableField copyLabel="Source token"`: `useCopy`'s toast for the current copy.
			const isCurrent = "generation" in inner && inner.generation === model.tokenCopy.generation
			const isDone = isCurrent && (inner._tag === "SucceededCopy" || inner._tag === "FailedCopy")
			const step: Return = {
				model: { ...model, tokenCopy: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotTokenCopyMessage({ message: m }),
				),
			}
			return isDone
				? { ...step, outMessage: copyToast("Source token", inner._tag === "SucceededCopy") }
				: step
		},
	})
