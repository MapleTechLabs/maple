import { Option } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "../../data/keyed"
import type { LoadFailure } from "../../data/load-failure"
import { requestKey } from "../../data/request-key"
import * as Dialog from "../../ui/dialog"
import * as Field from "../../ui/field"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import {
	FetchOrganizations,
	parsePatternList,
	type PlanetscaleCardModel,
	SelectOrganization,
	SetMetricsToken,
} from "./planetscale"
import { chain, requestStatus } from "./update-status"

// `PlanetScaleIntegrationCard`'s and its connect flow's state changes.

type Return = PageReturn<Model, Message>

const withCard = (model: Model, card: Partial<PlanetscaleCardModel>): Model => ({
	...model,
	planetscaleCard: { ...model.planetscaleCard, ...card },
})

const toast = (model: Model, type: "success" | "error", title: string, description = ""): Return => ({
	model,
	outMessage: PageOutMessage.RequestedToast({ type, title, description }),
})

export const planetscaleStatusOf = (model: Model) =>
	Option.getOrNull(AsyncData.getData(model.statuses.planetscale.data))

/** A write's `planetscaleIntegration` `reactivityKeys` (the target list carries no key). */
const refreshAfterWrite = (model: Model, context: PageContext): Return =>
	chain(model, [
		(next) => requestStatus(next, context, "planetscale", "Supersede"),
		(next) => requestStatus(next, context, "planetscaleDatabases", "Supersede"),
	])

export const requestOrganizations = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const key = requestKey(context.orgId, "planetscaleIntegration.organizations", {})
	return Option.match(Keyed.request(model.planetscaleCard.organizations, key, mode), {
		onNone: () => ({ model }),
		onSome: (organizations) => ({
			model: withCard(model, { organizations }),
			commands: [FetchOrganizations({ key })],
		}),
	})
}

/** The picker, seeded once with the saved binding. */
const seededPicker = (model: Model): Partial<PlanetscaleCardModel> => {
	const status = planetscaleStatusOf(model)
	return {
		selectedOrg: status?.organization ?? null,
		includeBranches: Field.init(status?.scrape_target?.include_branches.join(", ") ?? ""),
		excludeBranches: Field.init(status?.scrape_target?.exclude_branches.join(", ") ?? ""),
	}
}

/** Once authorized, Choose data's picker reads the organizations; a bound org seeds it once. */
export const ensurePicker = (model: Model, context: PageContext): Return => {
	const status = planetscaleStatusOf(model)
	if (status === null || (!status.connected && !status.pending_org_selection)) return { model }
	const card = model.planetscaleCard
	const seeded =
		status.connected && card.selectedOrg === null && !card.isSelecting
			? withCard(model, seededPicker(model))
			: model
	return requestOrganizations(seeded, context, "Load")
}

const dialogStep = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { pickerDialog: step.model }),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotPickerDialogMessage({ message }),
	),
})

/** "Edit data": the picker dialog, seeded with the current binding. */
export const clickedChange = (model: Model, context: PageContext): Return => {
	const seeded = withCard(model, seededPicker(model))
	return chain(seeded, [
		(next) => dialogStep(next, Dialog.open(next.planetscaleCard.pickerDialog)),
		(next) => requestOrganizations(next, context, "Load"),
	])
}

export const gotPickerDialog = (model: Model, message: Dialog.Message): Return =>
	model.planetscaleCard.isSelecting
		? { model }
		: dialogStep(model, Dialog.update(model.planetscaleCard.pickerDialog, message))

export const gotBranchField = (
	model: Model,
	field: "include" | "exclude",
	message: Field.Message,
): Return => {
	const current =
		field === "include" ? model.planetscaleCard.includeBranches : model.planetscaleCard.excludeBranches
	const step = Field.update(current, message)
	return {
		model: withCard(
			model,
			field === "include" ? { includeBranches: step.model } : { excludeBranches: step.model },
		),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			Message.GotBranchFieldMessage({ field, message: inner }),
		),
	}
}

/** Cancel closes the dialog. */
export const clickedPickerCancel = (model: Model): Return =>
	model.planetscaleCard.pickerDialog.isOpen
		? dialogStep(model, Dialog.close(model.planetscaleCard.pickerDialog))
		: { model }

export const submittedOrganization = (model: Model): Return => {
	const card = model.planetscaleCard
	if (card.selectedOrg === null || card.isSelecting) return { model }
	return {
		model: withCard(model, { isSelecting: true }),
		commands: [
			SelectOrganization({
				organization: card.selectedOrg,
				includeBranches: parsePatternList(card.includeBranches.value),
				excludeBranches: parsePatternList(card.excludeBranches.value),
			}),
		],
	}
}

export const completedSelect = (
	model: Model,
	context: PageContext,
	organization: string,
	failure: LoadFailure | null,
): Return => {
	const settled = withCard(model, { isSelecting: false })
	if (failure !== null)
		return toast(settled, "error", "Failed to connect PlanetScale organization", failure.message)
	return chain(settled, [
		(next) => toast(next, "success", `PlanetScale organization ${organization} connected`),
		(next) => refreshAfterWrite(next, context),
		(next) => requestOrganizations(next, context, "Refresh"),
		(next) =>
			next.planetscaleCard.pickerDialog.isOpen
				? dialogStep(next, Dialog.close(next.planetscaleCard.pickerDialog))
				: { model: next },
	])
}

export const updateCard = (model: Model, card: Partial<PlanetscaleCardModel>): Return => ({
	model: withCard(model, card),
})

export const gotTokenField = (model: Model, field: "id" | "secret", message: Field.Message): Return => {
	const current = field === "id" ? model.planetscaleCard.tokenId : model.planetscaleCard.tokenSecret
	const step = Field.update(current, message)
	return {
		model: withCard(model, field === "id" ? { tokenId: step.model } : { tokenSecret: step.model }),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			Message.GotPlanetscaleTokenField({ field, message: inner }),
		),
	}
}

export const submittedToken = (model: Model): Return => {
	const card = model.planetscaleCard
	const tokenId = card.tokenId.value.trim()
	const tokenSecret = card.tokenSecret.value.trim()
	if (card.isSavingToken || tokenId === "" || tokenSecret === "") return { model }
	return {
		model: withCard(model, { isSavingToken: true, tokenError: null }),
		commands: [SetMetricsToken({ tokenId, tokenSecret })],
	}
}

/** PlanetScale checks the token before Maple stores it, so a failure saved nothing. */
export const completedToken = (model: Model, context: PageContext, failure: LoadFailure | null): Return =>
	failure !== null
		? { model: withCard(model, { isSavingToken: false, tokenError: failure.message }) }
		: refreshAfterWrite(
				withCard(model, {
					isSavingToken: false,
					tokenError: null,
					isReplacingToken: false,
					tokenId: Field.init(),
					tokenSecret: Field.init(),
				}),
				context,
			)
