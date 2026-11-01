import { V2AttributeMapping, V2Recommendation } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import * as Combobox from "../../../ui/combobox"
import * as Dialog from "../../../ui/dialog"
import * as Field from "../../../ui/field"
import { toLoadFailure } from "../../../data/load-failure"
import { PageOutMessage } from "../../contract"
import * as MappingDialog from "./mapping-dialog"
import { Message } from "./message"
import type { Model } from "./model"
import { init, type InitOptions, update } from "./update"

const options: InitOptions = {
	isAdmin: true,
	orgKey: "default",
	timeZone: "UTC",
	pinnedNamespace: null,
}
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const step = (model: Model, message: Message) => update(model, message, options)

const rename = Schema.decodeUnknownSync(V2Recommendation)({
	id: "rec_YofPTrK9782DWwcnXhpcCw",
	object: "recommendation",
	number: 7,
	recommendation_key: "rename:http.status_code",
	kind: "rename",
	source_key: "http.status_code",
	canonical_key: "http.response.status_code",
	status: "open",
	usage_count: 4182,
	opened_at: "2026-07-01T12:00:00.000Z",
	updated_at: "2026-07-15T09:12:00.000Z",
	resolved_at: null,
})
const mapping = Schema.decodeUnknownSync(V2AttributeMapping)({
	id: "amap_YofPTrK9782DWwcnXhpcCw",
	object: "attribute_mapping",
	name: "Promote team label",
	source_context: "resource",
	source_key: "labels.team",
	target_key: "team",
	operation: "copy",
	enabled: false,
	created_at: "2026-07-01T12:00:00.000Z",
	updated_at: "2026-07-15T09:12:00.000Z",
})

const loaded = (): Model =>
	[
		Message.CompletedFetchRecommendations({ result: Result.succeed([rename]) }),
		Message.CompletedFetchMappings({ result: Result.succeed([mapping]) }),
	].reduce((model, message) => step(model, message).model, init(options).model)

describe("ingestion tab", () => {
	test("entry reads the overview, ingest keys, both rule lists and the stored framework", () => {
		expect(names(init(options).commands)).toEqual(
			expect.arrayContaining([
				"FetchIngestOverview",
				"FetchIngestionKeys",
				"FetchRecommendations",
				"FetchAttributeMappings",
				"ReadQuickStartFramework",
			]),
		)
	})

	test("regenerating a key asks first, refetches the pair and says the old key was revoked", () => {
		const asked = step(loaded(), Message.ClickedRegenerateKey({ kind: "private" })).model
		expect([asked.rollDialog.isOpen, asked.rollType]).toEqual([true, "private"])
		const rolling = step(asked, Message.ClickedConfirmRoll())
		expect(rolling.commands?.[0]).toMatchObject({ name: "RollIngestKey", args: { kind: "private" } })
		expect(step(rolling.model, Message.ClickedConfirmRoll()).commands ?? []).toEqual([])
		const rolled = step(
			rolling.model,
			Message.CompletedRollKey({ kind: "private", result: Result.succeed(undefined) }),
		)
		expect(names(rolled.commands)).toContain("FetchIngestionKeys")
		expect([rolled.model.isRolling, rolled.model.rollDialog.isOpen]).toEqual([false, false])
		expect(rolled.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "Private key regenerated. Previous key was revoked immediately.",
				description: "",
			}),
		)
	})

	test("a failed regenerate closes the dialog with an error toast and keeps the pair", () => {
		const rolling = step(
			step(loaded(), Message.ClickedRegenerateKey({ kind: "public" })).model,
			Message.ClickedConfirmRoll(),
		)
		const failure = toLoadFailure(new Error("boom"))
		const failed = step(
			rolling.model,
			Message.CompletedRollKey({ kind: "public", result: Result.fail(failure) }),
		)
		expect(names(failed.commands)).not.toContain("FetchIngestionKeys")
		expect(failed.model.rollDialog.isOpen).toBe(false)
		expect(failed.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "error",
				title: "Couldn't regenerate the key",
				description: failure.message,
			}),
		)
	})

	test("reveal toggles one key at a time", () => {
		const shown = step(loaded(), Message.ToggledKeyReveal({ kind: "public" })).model
		expect(shown.revealedKeys).toEqual(["public"])
		expect(step(shown, Message.ToggledKeyReveal({ kind: "public" })).model.revealedKeys).toEqual([])
	})

	test("applying a rename creates the copy mapping, then refreshes both lists with a toast", () => {
		const applying = step(loaded(), Message.ClickedApplyRecommendation({ id: rename.id }))
		expect(applying.commands?.[0]).toMatchObject({
			name: "ApplyRecommendation",
			args: { sourceKey: "http.status_code", canonicalKey: "http.response.status_code" },
		})
		const applied = step(
			applying.model,
			Message.CompletedRecommendationAction({
				id: rename.id,
				action: "apply",
				label: "http.status_code → http.response.status_code",
				result: Result.succeed(undefined),
			}),
		)
		expect(names(applied.commands)).toEqual(
			expect.arrayContaining(["FetchRecommendations", "FetchAttributeMappings"]),
		)
		expect(applied.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "Mapping created: http.status_code → http.response.status_code",
				description: "",
			}),
		)
	})

	test("a toggle flips the mapping once until its answer lands", () => {
		const toggling = step(loaded(), Message.ToggledMapping({ id: mapping.id }))
		expect(toggling.commands?.[0]).toMatchObject({
			name: "ToggleAttributeMapping",
			args: { isEnabled: true },
		})
		expect(step(toggling.model, Message.ToggledMapping({ id: mapping.id })).commands ?? []).toEqual([])
	})

	test("the add dialog posts the trimmed form", () => {
		const dialog = (message: MappingDialog.Message) => Message.GotMappingDialogMessage({ message })
		const opened = step(loaded(), Message.ClickedAddMapping())
		expect(names(opened.commands)).toContain("FetchMappingAttributeKeys")
		const filled = [
			dialog(
				MappingDialog.Message.GotNameMessage({
					message: Field.Message.ChangedValue({ value: " Status " }),
				}),
			),
			dialog(
				MappingDialog.Message.GotKeyMessage({
					field: "sourceKey",
					message: Combobox.Message.ChangedInput({ value: "a.b" }),
				}),
			),
			dialog(
				MappingDialog.Message.GotKeyMessage({
					field: "targetKey",
					message: Combobox.Message.ChangedInput({ value: "c.d" }),
				}),
			),
		].reduce((model, message) => step(model, message).model, opened.model)
		const saving = step(filled, dialog(MappingDialog.Message.ClickedSave()))
		expect(saving.commands?.[0]).toMatchObject({
			name: "SaveAttributeMapping",
			args: {
				editingId: null,
				payload: {
					name: "Status",
					source_context: "span",
					source_key: "a.b",
					target_key: "c.d",
					operation: "copy",
				},
			},
		})
	})

	test("Escape in an open key popup closes the popup only; the next Escape closes the dialog", () => {
		const dialog = (message: MappingDialog.Message) => Message.GotMappingDialogMessage({ message })
		const escape = Combobox.Message.PressedInputKey({ key: "Escape", items: [], isUnfiltered: false })
		const isOpen = (model: Model) => model.mappingDialog.dialog.isOpen
		// One keydown is two Messages: the input's, then the dialog portal's as it bubbles.
		const pressEscape = (model: Model) =>
			[
				dialog(MappingDialog.Message.GotKeyMessage({ field: "sourceKey", message: escape })),
				dialog(MappingDialog.Message.GotDialogMessage({ message: Dialog.Message.PressedEscape() })),
			].reduce((current, message) => step(current, message).model, model)
		const typed = [
			Message.ClickedAddMapping(),
			dialog(
				MappingDialog.Message.GotKeyMessage({
					field: "sourceKey",
					message: Combobox.Message.ChangedInput({ value: "http" }),
				}),
			),
		].reduce((model, message) => step(model, message).model, loaded())
		expect(typed.mappingDialog.sourceKey.isOpen).toBe(true)
		const once = pressEscape(typed)
		expect([once.mappingDialog.sourceKey.isOpen, isOpen(once)]).toEqual([false, true])
		expect(isOpen(pressEscape(once))).toBe(false)
	})
})
