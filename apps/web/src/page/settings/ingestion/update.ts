import type { RecommendationPublicId } from "@maple/domain/http/v2"
import { Array, Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import { PageOutMessage, type PageReturn } from "../../contract"
import { revisitData } from "../kit/revisit"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as Tabs from "../../../ui/tabs"
import {
	ApplyRecommendation,
	DeleteMapping,
	FetchIngestionKeys,
	FetchIngestOverview,
	FetchMappings,
	FetchRecommendations,
	ReadFramework,
	RollIngestKey,
	SaveFramework,
	ToggleMapping,
	TriageRecommendation,
} from "./command"
import * as IngestRules from "./ingest-rules"
import * as MappingDialog from "./mapping-dialog"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>

export type InitOptions = Readonly<{
	isAdmin: boolean
	/** The `ingestRules` rollout flag; off means no ingest rules section and no rules requests. */
	hasIngestRules: boolean
	/** `useAuth().orgId` in Clerk mode, `"default"` self-hosted: the quick-start storage key. */
	orgKey: string
	timeZone: string
	pinnedNamespace: string | null
}>

type RecommendationId = typeof RecommendationPublicId.Type

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

export const init = (options: InitOptions): Return => ({
	model: {
		isAdmin: options.isAdmin,
		hasIngestRules: options.hasIngestRules,
		overview: AsyncData.Loading(),
		ingest: AsyncData.Loading(),
		endpointCopy: CopyButton.init(),
		revealedKeys: [],
		keyCopies: {},
		rollDialog: Dialog.init("ingestion-key-roll", "alert-dialog"),
		rollType: "public",
		isRolling: false,
		isSetupExpanded: false,
		framework: "nodejs",
		setupTabs: Tabs.init({
			idBase: 40,
			values: ["install", "instrument", "claude-code"],
			selected: "install",
		}),
		packageTabs: Tabs.init({ idBase: 50, values: ["npm", "yarn", "pnpm", "bun"], selected: "npm" }),
		snippetCopies: {},
		recommendations: AsyncData.Loading(),
		recommendationTab: "open",
		pendingRecommendations: [],
		ingestRules: IngestRules.init(),
		mappings: AsyncData.Loading(),
		pendingToggles: [],
		rowMenus: {},
		mappingDialog: MappingDialog.init("mapping-dialog"),
		deleteDialog: Dialog.init("mapping-delete", "alert-dialog"),
		deleting: null,
		isDeleting: false,
	},
	commands: [
		FetchIngestOverview({ timeZone: options.timeZone, pinnedNamespace: options.pinnedNamespace }),
		FetchIngestionKeys(),
		FetchRecommendations(),
		...(options.hasIngestRules ? ingestRulesFetches() : []),
		FetchMappings(),
		ReadFramework({ orgKey: options.orgKey }),
	],
})

const ingestRulesFetches = () => [
	Command.mapMessage(IngestRules.FetchIngestRules(), (message) =>
		Message.GotIngestRulesMessage({ message }),
	),
	Command.mapMessage(IngestRules.FetchIngestRuleStats(), (message) =>
		Message.GotIngestRulesMessage({ message }),
	),
]

/** `revisit` for an org without the ingest rules rollout: the rest of the tab, no rules requests. */
const revisitWithoutRules = (model: Model, options: InitOptions): Return => {
	const overview = revisitData(model.overview, () =>
		FetchIngestOverview({ timeZone: options.timeZone, pinnedNamespace: options.pinnedNamespace }),
	)
	const ingest = revisitData(model.ingest, FetchIngestionKeys)
	const recommendations = revisitData(model.recommendations, FetchRecommendations)
	const mappings = revisitData(model.mappings, FetchMappings)
	return {
		model: {
			...model,
			overview: overview.data,
			ingest: ingest.data,
			recommendations: recommendations.data,
			mappings: mappings.data,
		},
		commands: [
			...overview.commands,
			...ingest.commands,
			...recommendations.commands,
			...mappings.commands,
		],
	}
}

/** A refetch keeps the rows on screen (`useAtomRefresh`'s `waiting`). */
const refresh = <A, E>(data: AsyncData.AsyncData<A, E>) =>
	Option.getOrElse(AsyncData.revalidate(data), () => data)

const withoutPending = (ids: ReadonlyArray<string>, id: string) => ids.filter((entry) => entry !== id)

const liftDeleteDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, deleteDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotDeleteDialogMessage({ message }),
	),
})

const liftMappingDialog = (model: Model, step: ReturnType<typeof MappingDialog.update>): Return => {
	const out = step.outMessage
	const lifted: Return = {
		model: { ...model, mappingDialog: step.model },
		commands: Command.mapMessages(step.commands ?? [], (message) =>
			Message.GotMappingDialogMessage({ message }),
		),
	}
	if (out === undefined) return lifted
	if (out._tag === "FailedSave")
		return {
			...lifted,
			outMessage: toast(
				"error",
				out.isCreate ? "Failed to create attribute mapping" : "Failed to update attribute mapping",
				out.description,
			),
		}
	return {
		model: {
			...lifted.model,
			mappings: refresh(lifted.model.mappings),
			recommendations: refresh(lifted.model.recommendations),
		},
		commands: [...(lifted.commands ?? []), FetchMappings(), FetchRecommendations()],
		outMessage: toast(
			"success",
			out.isCreate ? "Attribute mapping created" : "Attribute mapping updated",
		),
	}
}

const liftIngestRules = (model: Model, step: ReturnType<typeof IngestRules.update>): Return => {
	const lifted: Return = {
		model: { ...model, ingestRules: step.model },
		commands: Command.mapMessages(step.commands ?? [], (message) =>
			Message.GotIngestRulesMessage({ message }),
		),
	}
	return step.outMessage === undefined ? lifted : { ...lifted, outMessage: step.outMessage }
}

const liftRollDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, rollDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotRollDialogMessage({ message }),
	),
})

const mappingById = (model: Model, id: string) =>
	Array.findFirst(
		AsyncData.getOrElse(model.mappings, () => []),
		(mapping) => mapping.id === id,
	)

const pickedRowAction = (model: Model, menuId: string, value: string): Return =>
	Option.match(mappingById(model, menuId.replace(/^mapping-row-/, "")), {
		onNone: () => ({ model }),
		onSome: (mapping) =>
			value === "delete"
				? liftDeleteDialog({ ...model, deleting: mapping }, Dialog.open(model.deleteDialog))
				: liftMappingDialog(model, MappingDialog.open(model.mappingDialog, mapping)),
	})

const recommendationById = (model: Model, id: RecommendationId) =>
	Array.findFirst(
		AsyncData.getOrElse(model.recommendations, () => []),
		(issue) => issue.id === id,
	)

const triage = (model: Model, id: RecommendationId, action: "dismiss" | "reopen"): Return =>
	model.pendingRecommendations.includes(id)
		? { model }
		: {
				model: { ...model, pendingRecommendations: [...model.pendingRecommendations, id] },
				commands: [TriageRecommendation({ id, action })],
			}

/** Back on the tab: the overview, keys, recommendations and mappings stay up while they load again. */
export const revisit = (model: Model, options: InitOptions): Return => {
	const overview = revisitData(model.overview, () =>
		FetchIngestOverview({ timeZone: options.timeZone, pinnedNamespace: options.pinnedNamespace }),
	)
	const ingest = revisitData(model.ingest, FetchIngestionKeys)
	const recommendations = revisitData(model.recommendations, FetchRecommendations)
	const mappings = revisitData(model.mappings, FetchMappings)
	if (!model.hasIngestRules) return revisitWithoutRules(model, options)
	const rules = revisitData(model.ingestRules.rules, () =>
		Command.mapMessage(IngestRules.FetchIngestRules(), (message) =>
			Message.GotIngestRulesMessage({ message }),
		),
	)
	const stats = revisitData(model.ingestRules.stats, () =>
		Command.mapMessage(IngestRules.FetchIngestRuleStats(), (message) =>
			Message.GotIngestRulesMessage({ message }),
		),
	)
	return {
		model: {
			...model,
			overview: overview.data,
			ingest: ingest.data,
			recommendations: recommendations.data,
			mappings: mappings.data,
			ingestRules: { ...model.ingestRules, rules: rules.data, stats: stats.data },
		},
		commands: [
			...overview.commands,
			...ingest.commands,
			...recommendations.commands,
			...mappings.commands,
			...rules.commands,
			...stats.commands,
		],
	}
}

export const update = (model: Model, message: Message, options: InitOptions): Return =>
	Message.match<Return>(message, {
		CompletedFetchOverview: ({ result }) => ({
			model: { ...model, overview: AsyncData.settle(model.overview, result) },
		}),
		CompletedFetchIngestKeys: ({ result }) => ({
			model: { ...model, ingest: AsyncData.settle(model.ingest, result) },
		}),
		CompletedFetchRecommendations: ({ result }) => ({
			model: { ...model, recommendations: AsyncData.settle(model.recommendations, result) },
		}),
		CompletedFetchMappings: ({ result }) => ({
			model: { ...model, mappings: AsyncData.settle(model.mappings, result) },
		}),
		ReadFramework: ({ framework }) => ({ model: framework === null ? model : { ...model, framework } }),
		TickedPoll: () => ({
			model: { ...model, overview: refresh(model.overview) },
			commands: [
				FetchIngestOverview({ timeZone: options.timeZone, pinnedNamespace: options.pinnedNamespace }),
			],
		}),
		GotEndpointCopyMessage: ({ message: child }) => {
			const step = CopyButton.update(model.endpointCopy, child)
			return {
				model: { ...model, endpointCopy: step.model },
				commands: Command.mapMessages(step.commands, (inner) =>
					Message.GotEndpointCopyMessage({ message: inner }),
				),
			}
		},
		ToggledKeyReveal: ({ kind }) => ({
			model: {
				...model,
				revealedKeys: model.revealedKeys.includes(kind)
					? model.revealedKeys.filter((entry) => entry !== kind)
					: [...model.revealedKeys, kind],
			},
		}),
		GotKeyCopyMessage: ({ kind, message: child }) => {
			const step = CopyButton.update(model.keyCopies[kind] ?? CopyButton.init(), child)
			return {
				model: { ...model, keyCopies: { ...model.keyCopies, [kind]: step.model } },
				commands: Command.mapMessages(step.commands, (inner) =>
					Message.GotKeyCopyMessage({ kind, message: inner }),
				),
			}
		},
		ClickedRegenerateKey: ({ kind }) =>
			model.isRolling
				? { model }
				: liftRollDialog({ ...model, rollType: kind }, Dialog.open(model.rollDialog)),
		GotRollDialogMessage: ({ message: child }) =>
			model.isRolling ? { model } : liftRollDialog(model, Dialog.update(model.rollDialog, child)),
		ClickedConfirmRoll: () =>
			model.isRolling
				? { model }
				: {
						model: { ...model, isRolling: true },
						commands: [RollIngestKey({ kind: model.rollType })],
					},
		CompletedRollKey: ({ kind, result }) => {
			// The dialog closes either way, after the toast.
			const closed = liftRollDialog({ ...model, isRolling: false }, Dialog.close(model.rollDialog))
			return Result.match(result, {
				onSuccess: () => ({
					model: { ...closed.model, ingest: refresh(closed.model.ingest) },
					commands: [...(closed.commands ?? []), FetchIngestionKeys()],
					outMessage: toast(
						"success",
						`${kind === "public" ? "Public" : "Private"} key regenerated. Previous key was revoked immediately.`,
					),
				}),
				onFailure: (error) => ({
					...closed,
					outMessage: toast("error", "Unable to complete request", error.message),
				}),
			})
		},
		ClickedShowSetup: () => ({ model: { ...model, isSetupExpanded: true } }),
		ClickedFramework: ({ framework }) => ({
			// The install tab stays; a new framework re-renders the snippets (copy states reset).
			model: { ...model, framework, snippetCopies: {} },
			commands: [SaveFramework({ orgKey: options.orgKey, framework })],
		}),
		CompletedSaveFramework: () => ({ model }),
		GotSetupTabsMessage: ({ message: child }) => {
			const step = Tabs.update(model.setupTabs, child)
			return {
				model: { ...model, setupTabs: step.model },
				commands: Command.mapMessages(step.commands, (inner) =>
					Message.GotSetupTabsMessage({ message: inner }),
				),
			}
		},
		GotPackageTabsMessage: ({ message: child }) => {
			const step = Tabs.update(model.packageTabs, child)
			return {
				model: { ...model, packageTabs: step.model },
				commands: Command.mapMessages(step.commands, (inner) =>
					Message.GotPackageTabsMessage({ message: inner }),
				),
			}
		},
		GotSnippetCopyMessage: ({ snippet, message: child }) => {
			const step = CopyButton.update(model.snippetCopies[snippet] ?? CopyButton.init(), child)
			return {
				model: { ...model, snippetCopies: { ...model.snippetCopies, [snippet]: step.model } },
				commands: Command.mapMessages(step.commands, (inner) =>
					Message.GotSnippetCopyMessage({ snippet, message: inner }),
				),
			}
		},
		ClickedRecommendationTab: ({ tab }) => ({ model: { ...model, recommendationTab: tab } }),
		ClickedApplyRecommendation: ({ id }) =>
			Option.match(recommendationById(model, id), {
				onNone: () => ({ model }),
				onSome: (issue) =>
					issue.kind !== "rename" ||
					issue.canonical_key === null ||
					model.pendingRecommendations.includes(id)
						? { model }
						: {
								model: {
									...model,
									pendingRecommendations: [...model.pendingRecommendations, id],
								},
								commands: [
									ApplyRecommendation({
										id,
										sourceKey: issue.source_key,
										canonicalKey: issue.canonical_key,
									}),
								],
							},
			}),
		ClickedDismissRecommendation: ({ id }) => triage(model, id, "dismiss"),
		ClickedReopenRecommendation: ({ id }) => triage(model, id, "reopen"),
		CompletedRecommendationAction: ({ id, action, label, result }) => {
			const settled = {
				...model,
				pendingRecommendations: withoutPending(model.pendingRecommendations, id),
			}
			return Result.match(result, {
				onSuccess: () =>
					action === "apply"
						? {
								model: {
									...settled,
									recommendations: refresh(settled.recommendations),
									mappings: refresh(settled.mappings),
								},
								commands: [FetchRecommendations(), FetchMappings()],
								outMessage: toast("success", `Mapping created: ${label}`),
							}
						: {
								model: { ...settled, recommendations: refresh(settled.recommendations) },
								commands: [FetchRecommendations()],
							},
				onFailure: (error) => ({
					model: settled,
					outMessage: toast(
						"error",
						action === "apply"
							? "Failed to create mapping"
							: action === "dismiss"
								? "Failed to dismiss recommendation"
								: "Failed to reopen recommendation",
						error.message,
					),
				}),
			})
		},
		GotIngestRulesMessage: ({ message: child }) =>
			liftIngestRules(model, IngestRules.update(model.ingestRules, child)),
		ClickedAddMapping: () => liftMappingDialog(model, MappingDialog.open(model.mappingDialog, null)),
		ToggledMapping: ({ id }) =>
			Option.match(mappingById(model, id), {
				onNone: () => ({ model }),
				onSome: (mapping) =>
					model.pendingToggles.includes(id)
						? { model }
						: {
								model: { ...model, pendingToggles: [...model.pendingToggles, id] },
								commands: [ToggleMapping({ id, isEnabled: !mapping.enabled })],
							},
			}),
		CompletedToggleMapping: ({ id, result }) => {
			const settled = { ...model, pendingToggles: withoutPending(model.pendingToggles, id) }
			return Result.match(result, {
				onSuccess: () => ({
					model: { ...settled, mappings: refresh(settled.mappings) },
					commands: [FetchMappings()],
				}),
				onFailure: (error) => ({
					model: settled,
					outMessage: toast("error", "Failed to update attribute mapping", error.message),
				}),
			})
		},
		GotRowMenuMessage: ({ menuId, message: child }) => {
			const step = Menu.update(model.rowMenus[menuId] ?? Menu.init(menuId), child)
			const next = { ...model, rowMenus: { ...model.rowMenus, [menuId]: step.model } }
			const commands = Command.mapMessages(step.commands ?? [], (inner) =>
				Message.GotRowMenuMessage({ menuId, message: inner }),
			)
			if (step.outMessage?._tag !== "SelectedItem") return { model: next, commands }
			const after = pickedRowAction(next, menuId, step.outMessage.value)
			return { ...after, commands: [...commands, ...(after.commands ?? [])] }
		},
		GotMappingDialogMessage: ({ message: child }) =>
			liftMappingDialog(model, MappingDialog.update(model.mappingDialog, child)),
		GotDeleteDialogMessage: ({ message: child }) =>
			model.isDeleting ? { model } : liftDeleteDialog(model, Dialog.update(model.deleteDialog, child)),
		ClickedConfirmDelete: () =>
			model.deleting === null || model.isDeleting
				? { model }
				: {
						model: { ...model, isDeleting: true },
						commands: [DeleteMapping({ id: model.deleting.id })],
					},
		CompletedDelete: ({ result }) =>
			Result.match(result, {
				onSuccess: () => {
					const closed = liftDeleteDialog(
						{ ...model, isDeleting: false },
						Dialog.close(model.deleteDialog),
					)
					return {
						model: {
							...closed.model,
							mappings: refresh(closed.model.mappings),
							recommendations: refresh(closed.model.recommendations),
						},
						commands: [...(closed.commands ?? []), FetchMappings(), FetchRecommendations()],
						outMessage: toast("success", "Attribute mapping deleted"),
					}
				},
				onFailure: (error) => ({
					model: { ...model, isDeleting: false },
					outMessage: toast("error", "Failed to delete attribute mapping", error.message),
				}),
			}),
		ClickedRetryMappings: () => ({
			model: { ...model, mappings: AsyncData.Loading() },
			commands: [FetchMappings()],
		}),
		ClickedRetryIngestKeys: () => ({
			model: { ...model, ingest: AsyncData.Loading() },
			commands: [FetchIngestionKeys()],
		}),
	})
