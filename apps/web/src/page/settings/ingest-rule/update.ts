import { toV2IngestRuleAction } from "@maple/domain/http/v2"
import type { IngestRuleSignal } from "@maple/domain/ingest-rules"
import { Option, Result, Array as Arr, Record as Rec, String as Str } from "effect"
import { AsyncData, Command } from "foldkit"
import type { AppRoute } from "../../../route"
import * as Combobox from "@maple/views/ui/combobox"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import {
	DebounceEstimate,
	FetchEstimate,
	FetchImpact,
	FetchKeys,
	FetchRule,
	FetchSamples,
	FetchServices,
	FetchSession,
	SaveRule,
} from "./command"
import {
	type ConditionDraft,
	defaultCondition,
	type Draft,
	draftProblems,
	emptyDraft,
	fieldsFor,
	isKeyed,
	specOf,
	joinList,
	splitList,
} from "./form"
import { ingestionHref, ruleIdFromUrl } from "./hrefs"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import type { PreviewSignal } from "./preview"
import { estimateKeyOf, estimateParamsOf } from "./estimate"
import { draftFromSuggestion } from "./suggested"
import { draftFromRule, isTemplateId, TEMPLATES } from "./templates"

type Return = PageReturn<Model, Message>
type EditorRoute = Extract<AppRoute, { readonly _tag: "IngestRuleNew" | "IngestRule" }>

export const keyBoxId = (conditionId: number) => `ingest-rule-key-${conditionId}`

/** The signal the preview reads: the current one while still chosen, else the first previewable one. */
const previewSignalFor = (signals: ReadonlyArray<IngestRuleSignal>, current: PreviewSignal): PreviewSignal =>
	signals.includes(current)
		? current
		: signals.includes("logs")
			? "logs"
			: signals.includes("traces")
				? "traces"
				: current

const isPreviewable = (signals: ReadonlyArray<IngestRuleSignal>) =>
	signals.includes("logs") || signals.includes("traces")

/** A fresh sample read for the model's signal and service, unless the draft has nothing to preview. */
const requestSamples = (model: Model): Return => {
	if (!isPreviewable(model.draft.signals)) return { model: { ...model, samples: AsyncData.Idle() } }
	const key = `${model.previewSignal}|${model.previewService}`
	return {
		model: { ...model, samples: AsyncData.Loading(), samplesKey: key },
		commands: [FetchSamples({ key, signal: model.previewSignal, service: model.previewService })],
	}
}

/** Every attribute condition gets a key autocomplete holding its key. */
const withKeyBoxes = (model: Model): Model => {
	const missing = Arr.filter(
		model.draft.conditions,
		(condition) => isKeyed(condition.field) && model.keyBoxes[String(condition.id)] === undefined,
	)
	if (missing.length === 0) return model
	const added = Rec.fromEntries(
		Arr.map(missing, (condition) => [
			String(condition.id),
			{ ...Combobox.init(keyBoxId(condition.id), "autocomplete"), inputValue: condition.key },
		]),
	)
	return { ...model, keyBoxes: { ...model.keyBoxes, ...added } }
}

/** Sets the draft; a change of signals can move the preview to another signal and refetch. */
const withDraft = (model: Model, draft: Draft): Return => {
	const next = withKeyBoxes({ ...model, draft, saveFailure: null })
	const previewSignal = previewSignalFor(draft.signals, model.previewSignal)
	const wasPreviewable = isPreviewable(model.draft.signals)
	if (previewSignal === model.previewSignal && wasPreviewable === isPreviewable(draft.signals))
		return { model: next }
	return requestSamples({ ...next, previewSignal })
}

const patchDraft = (model: Model, patch: Partial<Draft>): Return =>
	withDraft(model, { ...model.draft, ...patch })

const mapCondition = (
	model: Model,
	id: number,
	change: (condition: ConditionDraft) => ConditionDraft,
): Return =>
	patchDraft(model, {
		conditions: Arr.map(model.draft.conditions, (condition) =>
			condition.id === id ? change(condition) : condition,
		),
	})

const toggled = <A>(list: ReadonlyArray<A>, value: A): ReadonlyArray<A> =>
	list.includes(value) ? Arr.filter(list, (entry) => entry !== value) : [...list, value]

const initial = (route: EditorRoute, context: PageContext): Return => {
	const parsed = route._tag === "IngestRule" ? ruleIdFromUrl(route.ruleId) : Option.none()
	const editingId = Option.getOrNull(parsed)
	const template = route._tag === "IngestRuleNew" ? route.search.template : undefined
	const suggested = route._tag === "IngestRuleNew" ? draftFromSuggestion(route.search) : undefined
	const draft =
		template !== undefined && isTemplateId(template)
			? TEMPLATES[template].draft
			: (suggested ?? emptyDraft)
	const base: Model = withKeyBoxes({
		editingId,
		isBadId: route._tag === "IngestRule" && editingId === null,
		existing: editingId === null ? AsyncData.Idle() : AsyncData.Loading(),
		draft,
		keyBoxes: {},
		spanKeys: [],
		logKeys: [],
		resourceKeys: [],
		services: [],
		previewSignal: previewSignalFor(draft.signals, "logs"),
		previewService: "",
		samples: AsyncData.Idle(),
		samplesKey: "",
		impact: editingId === null ? AsyncData.Idle() : AsyncData.Loading(),
		impactWindow: "24h",
		estimate: AsyncData.Idle(),
		estimateKey: "",
		estimateSeq: 0,
		grants: [],
		isSessionLoaded: false,
		isSaving: false,
		saveFailure: null,
	})
	const common = [
		FetchSession({ orgId: context.orgId }),
		FetchKeys({ scope: "span" }),
		FetchKeys({ scope: "log" }),
		FetchKeys({ scope: "resource" }),
		FetchServices(),
	]
	if (editingId !== null)
		return {
			model: base,
			commands: [...common, FetchRule({ id: editingId }), FetchImpact({ window: base.impactWindow })],
		}
	const sampled = requestSamples(base)
	return { model: sampled.model, commands: [...common, ...(sampled.commands ?? [])] }
}

const save = (model: Model): Return => {
	if (model.isSaving || !canManage(model) || draftProblems(model.draft).length > 0) return { model }
	const spec = specOf(model.draft)
	const payload = {
		name: Str.trim(model.draft.name),
		enabled: model.draft.enabled,
		signals: spec.signals,
		conditions: spec.conditions,
		action: toV2IngestRuleAction(spec.action),
	}
	return {
		model: { ...model, isSaving: true, saveFailure: null },
		commands: [SaveRule({ editingId: model.editingId, payload })],
	}
}

const updateKeyBox = (model: Model, id: number, child: Combobox.Message): Return => {
	const box = model.keyBoxes[String(id)] ?? Combobox.init(keyBoxId(id), "autocomplete")
	const step = Combobox.update(box, child)
	const next = mapCondition(
		{ ...model, keyBoxes: { ...model.keyBoxes, [String(id)]: step.model } },
		id,
		(condition) => ({ ...condition, key: step.model.inputValue }),
	)
	return {
		...next,
		commands: [
			...Command.mapMessages(step.commands ?? [], (message) => Message.GotKeyMessage({ id, message })),
			...(next.commands ?? []),
		],
	}
}

/** A fresh count, after the debounce, when the step changed what the draft would count. */
const withEstimate = (step: Return): Return => {
	const key = estimateKeyOf(step.model.draft)
	if (key === step.model.estimateKey) return step
	const seq = step.model.estimateSeq + 1
	return {
		...step,
		model: {
			...step.model,
			estimateKey: key,
			estimateSeq: seq,
			estimate: key === "" ? AsyncData.Idle() : AsyncData.Loading(),
		},
		commands: [...(step.commands ?? []), ...(key === "" ? [] : [DebounceEstimate({ seq })])],
	}
}

const fetchEstimate = (model: Model): Return => {
	const payload = estimateParamsOf(model.draft)
	return payload === null
		? { model }
		: {
				model: { ...model, estimate: AsyncData.Loading() },
				commands: [FetchEstimate({ key: model.estimateKey, payload })],
			}
}

export const init = (route: EditorRoute, context: PageContext): Return =>
	withEstimate(initial(route, context))

export const update = (model: Model, message: Message, context: PageContext): Return =>
	withEstimate(step(model, message, context))

const step = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchExisting: ({ result }) =>
			Result.match(result, {
				onSuccess: (rule) => {
					const draft = draftFromRule(rule)
					const previewSignal = previewSignalFor(draft.signals, model.previewSignal)
					const filled = {
						...model,
						existing: AsyncData.succeed(rule),
						draft,
						keyBoxes: {},
						previewSignal,
					}
					return requestSamples(withKeyBoxes(filled))
				},
				onFailure: (error) => ({ model: { ...model, existing: AsyncData.fail(error) } }),
			}),
		CompletedFetchSession: ({ orgId, grants }) =>
			orgId === context.orgId ? { model: { ...model, grants, isSessionLoaded: true } } : { model },
		CompletedFetchKeys: ({ scope, keys }) => ({
			model:
				scope === "span"
					? { ...model, spanKeys: keys }
					: scope === "log"
						? { ...model, logKeys: keys }
						: { ...model, resourceKeys: keys },
		}),
		CompletedFetchServices: ({ services }) => ({ model: { ...model, services } }),
		CompletedFetchSamples: ({ key, result }) =>
			key === model.samplesKey
				? { model: { ...model, samples: AsyncData.settle(model.samples, result) } }
				: { model },
		ChangedText: ({ part, value }) => patchDraft(model, { [part]: value }),
		ToggledEnabled: () => patchDraft(model, { enabled: !model.draft.enabled }),
		ToggledSignal: ({ signal }) => patchDraft(model, { signals: toggled(model.draft.signals, signal) }),
		PickedAction: ({ actionType }) => patchDraft(model, { actionType }),
		AddedCondition: () => {
			const field = fieldsFor(model.draft.signals)[0] ?? "service_name"
			return patchDraft(model, {
				conditions: [...model.draft.conditions, defaultCondition(model.draft.nextConditionId, field)],
				nextConditionId: model.draft.nextConditionId + 1,
			})
		},
		RemovedCondition: ({ id }) =>
			patchDraft(model, {
				conditions: Arr.filter(model.draft.conditions, (condition) => condition.id !== id),
			}),
		// The key autocomplete holds its own text; clear it with the key so it never shows a stale one.
		ChangedConditionField: ({ id, field }) => {
			const box = model.keyBoxes[String(id)]
			const cleared =
				box === undefined
					? model
					: { ...model, keyBoxes: { ...model.keyBoxes, [String(id)]: { ...box, inputValue: "" } } }
			return mapCondition(cleared, id, () => defaultCondition(id, field))
		},
		ChangedConditionOp: ({ id, op }) => mapCondition(model, id, (condition) => ({ ...condition, op })),
		ChangedConditionValue: ({ id, value }) =>
			mapCondition(model, id, (condition) => ({ ...condition, value })),
		ChangedConditionValues: ({ id, values }) =>
			mapCondition(model, id, (condition) => ({ ...condition, values })),
		ToggledConditionValue: ({ id, value }) =>
			mapCondition(model, id, (condition) => ({
				...condition,
				values: joinList(toggled(splitList(condition.values), value)),
			})),
		GotKeyMessage: ({ id, message: child }) => updateKeyBox(model, id, child),
		ToggledDetector: ({ detector }) =>
			patchDraft(model, { detectors: toggled(model.draft.detectors, detector) }),
		ToggledScope: ({ scope }) => patchDraft(model, { scopes: toggled(model.draft.scopes, scope) }),
		PickedMethod: ({ method }) => patchDraft(model, { method }),
		PickedPreviewSignal: ({ signal }) =>
			signal === model.previewSignal ? { model } : requestSamples({ ...model, previewSignal: signal }),
		PickedPreviewService: ({ service }) =>
			service === model.previewService
				? { model }
				: requestSamples({ ...model, previewService: service }),
		ClickedRetryPreview: () => requestSamples(model),
		CompletedFetchImpact: ({ window, result }) =>
			window === model.impactWindow
				? { model: { ...model, impact: AsyncData.settle(model.impact, result) } }
				: { model },
		PickedImpactWindow: ({ window }) =>
			window === model.impactWindow || model.editingId === null
				? { model }
				: {
						model: { ...model, impactWindow: window, impact: AsyncData.Loading() },
						commands: [FetchImpact({ window })],
					},
		ElapsedEstimateDebounce: ({ seq }) => (seq === model.estimateSeq ? fetchEstimate(model) : { model }),
		CompletedFetchEstimate: ({ key, result }) =>
			key === model.estimateKey
				? { model: { ...model, estimate: AsyncData.settle(model.estimate, result) } }
				: { model },
		ClickedRetryEstimate: () => fetchEstimate(model),
		ClickedRetryImpact: () =>
			model.editingId === null
				? { model }
				: {
						model: { ...model, impact: AsyncData.Loading() },
						commands: [FetchImpact({ window: model.impactWindow })],
					},
		ClickedSave: () => save(model),
		CompletedSave: ({ result }) =>
			Result.match(result, {
				onSuccess: (): Return => ({
					model: { ...model, isSaving: false },
					outMessage: PageOutMessage.RequestedNavigation({
						url: ingestionHref(),
						isReplace: false,
						toast: {
							type: "success",
							title: model.editingId === null ? "Ingest rule created" : "Changes saved",
							description: "Applies to new data within 30 seconds.",
						},
					}),
				}),
				onFailure: (saveFailure): Return => ({ model: { ...model, isSaving: false, saveFailure } }),
			}),
	})
