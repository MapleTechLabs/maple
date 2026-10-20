import {
	EscalationConfidence,
	EscalationPolicyEvaluationRequest,
	type IssueEscalationPolicyDocument,
	IssueEscalationPolicyRule,
	IssueEscalationPolicyUpsertRequest,
	type IssueSeverity,
} from "@maple/domain/http"
import { AlertDestinationId } from "@maple/domain/primitives"
import { Array, Effect, Option, Result, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import * as Select from "../../../ui/select"
import { PageOutMessage, type PageReturn } from "../../contract"
import { revisitData } from "../kit/revisit"
import { SEVERITY_ORDER } from "../../errors/kit/severity"
import { ConfidenceChoice, DecisionSource, Message, type Model, PolicyDraft, type RuleDraft } from "./model"

type Return = PageReturn<Model, Message>

const settle = <A, B>(toMessage: (result: Result.Result<A, ReturnType<typeof toLoadFailure>>) => B) =>
	<E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.mapError(toLoadFailure), Effect.result, Effect.map(toMessage))

const FetchEscalationPolicy = Command.define("FetchEscalationPolicy", {
	messages: [Message.CompletedFetchPolicy],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.errors.getEscalationPolicy()).pipe(
		settle((result) => Message.CompletedFetchPolicy({ result })),
	),
})

const FetchRecentEscalations = Command.define("FetchRecentEscalations", {
	messages: [Message.CompletedFetchAttempts],
	execute: Effect.flatMap(MapleInternalApiClient, (client) =>
		client.errors.listRecentEscalations({ query: { limit: 20 } }),
	).pipe(settle((result) => Message.CompletedFetchAttempts({ result }))),
})

const SaveEscalationPolicy = Command.define("SaveEscalationPolicy", {
	args: { request: IssueEscalationPolicyUpsertRequest },
	messages: [Message.CompletedSavePolicy],
	execute: ({ request }) =>
		Effect.flatMap(MapleInternalApiClient, (client) => client.errors.upsertEscalationPolicy({ payload: request })).pipe(
			settle((result) => Message.CompletedSavePolicy({ result })),
		),
})

const EvaluateEscalationPolicy = Command.define("EvaluateEscalationPolicy", {
	args: { request: EscalationPolicyEvaluationRequest, revision: Schema.Number },
	messages: [Message.CompletedEvaluate],
	execute: ({ request, revision }) =>
		Effect.flatMap(MapleInternalApiClient, (client) => client.errors.evaluateEscalationPolicy({ payload: request })).pipe(
			settle((result) => Message.CompletedEvaluate({ revision, result })),
		),
})

export const init = (isAdmin: boolean): Return => ({
	model: {
		isAdmin,
		policy: AsyncData.Loading(),
		draft: null,
		isDirty: false,
		revision: 0,
		isSaving: false,
		confidenceSelects: Object.fromEntries(
			SEVERITY_ORDER.map((severity) => [severity, Select.init(`escalation-confidence-${severity}`, { value: "any", selectedIndex: 0 })]),
		),
		destinations: null,
		brokenLogos: [],
		severitySelect: Select.init("simulator-severity", { value: "high", selectedIndex: 1 }),
		source: "ai",
		confidence: "high",
		evaluated: null,
		isEvaluating: false,
		attempts: AsyncData.Loading(),
	},
	commands: [FetchEscalationPolicy(), FetchRecentEscalations()],
})

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

/** The stored policy as the form edits it: every severity, `any` where no floor is set. */
const draftOf = (policy: IssueEscalationPolicyDocument): PolicyDraft => {
	const ruleFor = (severity: IssueSeverity): RuleDraft =>
		Option.match(
			Array.findFirst(policy.rules, (rule) => rule.severity === severity),
			{
				onNone: (): RuleDraft => ({ destinationIds: [], minConfidence: "any" }),
				onSome: (rule): RuleDraft => ({ destinationIds: [...rule.destinationIds], minConfidence: rule.minConfidence ?? "any" }),
			},
		)
	return { enabled: policy.enabled, critical: ruleFor("critical"), high: ruleFor("high"), medium: ruleFor("medium"), low: ruleFor("low") }
}

const decodeDestinationIds = Schema.decodeUnknownSync(Schema.Array(AlertDestinationId))
const asConfidence = Schema.decodeUnknownOption(EscalationConfidence)
const asChoice = Schema.decodeUnknownOption(ConfidenceChoice)

const requestOf = (draft: PolicyDraft) =>
	new IssueEscalationPolicyUpsertRequest({
		enabled: draft.enabled,
		rules: SEVERITY_ORDER.filter((severity) => draft[severity].destinationIds.length > 0).map((severity) => {
			const minConfidence = draft[severity].minConfidence
			return new IssueEscalationPolicyRule({
				severity,
				destinationIds: decodeDestinationIds(draft[severity].destinationIds),
				...(minConfidence !== "any" && { minConfidence }),
			})
		}),
	})

const isSameDraft = Schema.toEquivalence(PolicyDraft)

/** An edit: dirty, and the revision moves so a stale simulation is dropped. */
const edit = (model: Model, change: (draft: PolicyDraft) => PolicyDraft): Return =>
	model.draft === null || !model.isAdmin || model.isSaving
		? { model }
		: { model: { ...model, draft: change(model.draft), isDirty: true, revision: model.revision + 1 } }

/** Back on the tab: the policy and attempts stay up while they load again; an unsaved draft is kept. */
export const revisit = (model: Model): Return => {
	const policy = revisitData(model.policy, FetchEscalationPolicy)
	const attempts = revisitData(model.attempts, FetchRecentEscalations)
	return {
		model: { ...model, policy: policy.data, attempts: attempts.data },
		commands: [...policy.commands, ...attempts.commands],
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedFetchPolicy: ({ result }) => {
			const policy = AsyncData.settle(model.policy, result)
			// An untouched form follows the stored policy (a revisit reads it again); edits are kept.
			const stored = Option.getOrNull(Option.map(AsyncData.getData(policy), draftOf))
			if (model.isDirty || stored === null || (model.draft !== null && isSameDraft(model.draft, stored))) {
				return { model: { ...model, policy, draft: model.draft ?? stored } }
			}
			return { model: { ...model, policy, draft: stored, revision: model.revision + 1 } }
		},
		CompletedFetchAttempts: ({ result }) => ({ model: { ...model, attempts: AsyncData.settle(model.attempts, result) } }),
		UpdatedDestinations: ({ destinations }) => ({ model: { ...model, destinations } }),
		FailedLoadProviderLogo: ({ type }) =>
			model.brokenLogos.includes(type) ? { model } : { model: { ...model, brokenLogos: [...model.brokenLogos, type] } },
		ClickedRetryPolicy: () => ({ model: { ...model, policy: AsyncData.Loading() }, commands: [FetchEscalationPolicy()] }),
		ToggledEnabled: () => edit(model, (draft) => ({ ...draft, enabled: !draft.enabled })),
		GotConfidenceSelectMessage: ({ severity, message: child }) => {
			const current = model.confidenceSelects[severity] ?? Select.init(`escalation-confidence-${severity}`, { value: "any", selectedIndex: 0 })
			const step = Select.update(current, child)
			const lifted: Return = {
				model: { ...model, confidenceSelects: { ...model.confidenceSelects, [severity]: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (inner) => Message.GotConfidenceSelectMessage({ severity, message: inner })),
			}
			return Option.match(Option.flatMap(Option.fromNullishOr(step.outMessage), (out) => asChoice(out.value)), {
				onNone: () => lifted,
				onSome: (minConfidence) => {
					const edited = edit(lifted.model, (draft) => ({ ...draft, [severity]: { ...draft[severity], minConfidence } }))
					return { ...edited, commands: lifted.commands }
				},
			})
		},
		ToggledDestination: ({ severity, destinationId }) =>
			edit(model, (draft) => {
				const ids = draft[severity].destinationIds
				const next = ids.includes(destinationId) ? ids.filter((id) => id !== destinationId) : [...ids, destinationId]
				return { ...draft, [severity]: { ...draft[severity], destinationIds: next } }
			}),
		ClickedSavePolicy: () =>
			model.draft === null || model.isSaving || !model.isAdmin
				? { model }
				: { model: { ...model, isSaving: true }, commands: [SaveEscalationPolicy({ request: requestOf(model.draft) })] },
		CompletedSavePolicy: ({ result }) =>
			Result.match(result, {
				onSuccess: () => ({
					model: { ...model, isSaving: false, isDirty: false, policy: Option.getOrElse(AsyncData.revalidate(model.policy), () => model.policy) },
					commands: [FetchEscalationPolicy()],
					outMessage: toast("success", "Escalation policy saved"),
				}),
				onFailure: (error) => ({
					model: { ...model, isSaving: false },
					outMessage: toast("error", "Failed to save escalation policy", error.message),
				}),
			}),
		GotSeveritySelectMessage: ({ message: child }) => {
			const step = Select.update(model.severitySelect, child)
			const value = step.outMessage?.value
			return {
				model: { ...model, severitySelect: value === undefined ? step.model : { ...step.model, value } },
				commands: Command.mapMessages(step.commands ?? [], (inner) => Message.GotSeveritySelectMessage({ message: inner })),
			}
		},
		ChangedSource: ({ value }) => ({ model: { ...model, source: value === "manual" ? "manual" : "ai" } }),
		ChangedConfidence: ({ value }) => ({
			model: { ...model, confidence: Option.getOrElse(asConfidence(value), () => "high" as const) },
		}),
		ClickedEvaluate: () => {
			if (model.isEvaluating || model.isDirty) return { model }
			const severity = Option.getOrElse(Schema.decodeUnknownOption(DecisionSource)(model.source), () => "ai" as const)
			const request = new EscalationPolicyEvaluationRequest({
				severity: SEVERITY_ORDER.find((value) => value === model.severitySelect.value) ?? "high",
				source: severity,
				...(severity === "ai" && { confidence: model.confidence }),
			})
			return {
				model: { ...model, isEvaluating: true, evaluated: null },
				commands: [EvaluateEscalationPolicy({ request, revision: model.revision })],
			}
		},
		CompletedEvaluate: ({ revision, result }) =>
			Result.match(result, {
				onSuccess: (decision) => ({ model: { ...model, isEvaluating: false, evaluated: { revision, decision } } }),
				onFailure: (error) => ({
					model: { ...model, isEvaluating: false },
					outMessage: toast("error", "Policy evaluation failed", error.message),
				}),
			}),
	})
