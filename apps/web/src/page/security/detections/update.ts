import type { AlertRuleId, AuditDetection } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import * as Dialog from "@maple/views/ui/dialog"
import { Array as Arr, Option, Result } from "effect"
import { Command as FoldkitCommand } from "foldkit"
import { isClerkAuthEnabled } from "../../../platform/auth-mode"
import type { AppRoute } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { chain, slotStep } from "../../kit/keyed-step"
import { acceptGrants } from "../../kit/session-grants"
import { detectionFormHref } from "../kit/detection-format"
import { DeleteDetection, FetchDetections, ReadDetectionsGrants, SaveDetectionEnabled } from "./command"
import { detectionById, detectionsOf } from "./derive"
import { accessOf, Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

type SecurityDetectionsRoute = Extract<AppRoute, { readonly _tag: "SecurityDetections" }>

const DELETE_DIALOG_ID = "security-detection-delete"

const keyOf = (context: PageContext) => requestKey(context.orgId, "auditTrail.listDetections", {})

/** The list, unless the session said the viewer may not read it. */
const readList = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	accessOf(model) !== "ask"
		? { model }
		: slotStep(
				model,
				model.list,
				(list) => ({ list }),
				keyOf(context),
				mode,
				(key) => FetchDetections({ key }),
			)

/**
 * Entering the page. `sessionDecides`: the hosted product, where the session says what the viewer
 * may read and nothing is asked before it answers. Self-hosted has one role and reads at once.
 */
export const enter = (context: PageContext, sessionDecides: boolean): Return => {
	const model: Model = {
		grants: sessionDecides ? [] : Policy.allPermissions,
		isGrantsRead: !sessionDecides,
		list: Keyed.idle(),
		togglingIds: [],
		confirmDeleteId: null,
		deletingId: null,
		deleteDialog: Dialog.init(DELETE_DIALOG_ID, "alert-dialog"),
	}
	const entered: Return = {
		model,
		commands: sessionDecides ? [ReadDetectionsGrants({ orgId: context.orgId })] : [],
	}
	return chain(entered, (next) => readList(next, context, "Load"))
}

export const init = (_route: SecurityDetectionsRoute, context: PageContext): Return =>
	enter(context, isClerkAuthEnabled)

const errorToast = (title: string, failure: LoadFailure): PageOutMessage =>
	PageOutMessage.RequestedToast({ type: "error", title, description: failure.message })

/** The list with `change` applied to the rows on screen: what the API answered, never a guess. */
const withRows = (
	model: Model,
	change: (rows: ReadonlyArray<AuditDetection>) => ReadonlyArray<AuditDetection>,
): Model => {
	const rows = detectionsOf(model)
	return rows === null || model.list.key === null
		? model
		: {
				...model,
				list: Keyed.accept(model.list, model.list.key, Result.succeed({ detections: change(rows) })),
			}
}

const withoutId = (ids: ReadonlyArray<AlertRuleId>, id: AlertRuleId): ReadonlyArray<AlertRuleId> =>
	Arr.filter(ids, (existing) => existing !== id)

/** The switch saves at once; it stays where it was until the API says what is stored. */
const toggle = (model: Model, id: AlertRuleId): Return =>
	Option.match(detectionById(model, id), {
		onNone: (): Return => ({ model }),
		onSome: (detection): Return =>
			Arr.contains(model.togglingIds, id)
				? { model }
				: {
						model: { ...model, togglingIds: [...model.togglingIds, id] },
						commands: [SaveDetectionEnabled({ id, enabled: !detection.enabled })],
					},
	})

const stepDeleteDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: {
		...model,
		deleteDialog: step.model,
		confirmDeleteId: step.outMessage?._tag === "Closed" ? null : model.confirmDeleteId,
	},
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotDeleteDialogMessage({ message }),
	),
})

const confirmDelete = (model: Model): Return =>
	model.confirmDeleteId === null || model.deletingId !== null
		? { model }
		: {
				model: { ...model, deletingId: model.confirmDeleteId },
				commands: [DeleteDetection({ id: model.confirmDeleteId })],
			}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedReadGrants: (answer) =>
			readList(acceptGrants(model, context.orgId, answer, { isGrantsRead: true }), context, "Load"),
		CompletedFetchDetections: ({ key, result }) => ({
			model: { ...model, list: Keyed.accept(model.list, key, result) },
		}),
		ClickedRetry: () => readList(model, context, "Refresh"),
		ClickedEdit: ({ id }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: detectionFormHref({ detectionId: id }),
				isReplace: false,
			}),
		}),
		ToggledDetection: ({ id }) => toggle(model, id),
		CompletedToggle: ({ id, result }) => {
			const settled = { ...model, togglingIds: withoutId(model.togglingIds, id) }
			return Result.match(result, {
				onSuccess: (saved): Return => ({
					model: withRows(settled, (rows) =>
						Arr.map(rows, (row) => (row.id === saved.id ? saved : row)),
					),
				}),
				onFailure: (failure): Return => ({
					model: settled,
					outMessage: errorToast("Couldn't update the detection", failure),
				}),
			})
		},
		ClickedDelete: ({ id }) =>
			Option.match(detectionById(model, id), {
				onNone: (): Return => ({ model }),
				onSome: (): Return =>
					stepDeleteDialog({ ...model, confirmDeleteId: id }, Dialog.open(model.deleteDialog)),
			}),
		GotDeleteDialogMessage: ({ message: child }) =>
			// A delete in flight keeps its dialog: closing it would hide whether it went through.
			model.deletingId !== null
				? { model }
				: stepDeleteDialog(model, Dialog.update(model.deleteDialog, child)),
		ClickedConfirmDelete: () => confirmDelete(model),
		CompletedDelete: ({ result }) => {
			const settled = { ...model, deletingId: null }
			return Result.match(result, {
				onSuccess: (deleted): Return => {
					const closed = stepDeleteDialog(settled, Dialog.close(settled.deleteDialog))
					return {
						...closed,
						model: withRows(closed.model, (rows) =>
							Arr.filter(rows, (row) => row.id !== deleted.id),
						),
						outMessage: PageOutMessage.RequestedToast({
							type: "success",
							title: "Detection deleted",
							description: "",
						}),
					}
				},
				onFailure: (failure): Return => ({
					model: settled,
					outMessage: errorToast("Couldn't delete the detection", failure),
				}),
			})
		},
	})
