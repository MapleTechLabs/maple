import { ONBOARDING_INTENT_IDS, type OnboardingIntent } from "../../lib/onboarding-intent"
import { ONBOARDING_ROLE_IDS } from "../../lib/onboarding-role"
import {
	frameworkOf,
	intentsOf,
	STACK_LANGUAGE_IDS,
	STACK_PLATFORM_IDS,
	type StackAnswers as StackPicks,
} from "../../lib/onboarding-stack"
import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { Effect, Option, Schema, SchemaGetter } from "effect"

// The quick start wizard's progress in localStorage `maple-onboarding-v6-<orgId>`, with normalisation
// of older saves (their role and intent steps are gone; the answers still feed the setup checklist).

export const STEP_IDS = ["plan", "stack", "connect", "team"] as const
export type StepId = (typeof STEP_IDS)[number]

const IntentSchema = Schema.Literals(ONBOARDING_INTENT_IDS)
const StoredIntentSchema = Schema.Literals([
	...ONBOARDING_INTENT_IDS,
	"slow_requests",
	"consolidate",
	"visibility",
])
const CURRENT_INTENT = {
	traces: "traces",
	logs: "logs",
	metrics: "metrics",
	errors: "errors",
	replays: "replays",
	service_map: "service_map",
	infrastructure: "infrastructure",
	alerts: "alerts",
	slow_requests: "traces",
	consolidate: "logs",
	visibility: "service_map",
} as const satisfies Record<typeof StoredIntentSchema.Type, OnboardingIntent>
const RoleSchema = Schema.NullOr(Schema.Literals(ONBOARDING_ROLE_IDS))
const StoredRoleSchema = Schema.NullOr(Schema.Literals([...ONBOARDING_ROLE_IDS, "engineer"]))

export const QualifyAnswers = Schema.Struct({
	role: RoleSchema,
	roleDetail: Schema.String,
	intents: Schema.Array(IntentSchema),
})
export type QualifyAnswers = typeof QualifyAnswers.Type

/** Older single-choice and themed saves, normalised at the storage boundary; arrays are written. */
const StoredQualifyAnswers = Schema.Struct({
	role: StoredRoleSchema,
	roleDetail: Schema.optionalKey(Schema.String),
	intent: Schema.optionalKey(Schema.NullOr(StoredIntentSchema)),
	intents: Schema.optionalKey(Schema.Array(StoredIntentSchema)),
}).pipe(
	Schema.decodeTo(QualifyAnswers, {
		decode: SchemaGetter.transform(({ role, roleDetail, intent, intents }) => ({
			role: role === "engineer" ? "backend" : role,
			roleDetail: roleDetail ?? "",
			intents: [
				...new Set((intents ?? (intent ? [intent] : [])).map((stored) => CURRENT_INTENT[stored])),
			],
		})),
		encode: SchemaGetter.transform(({ role, roleDetail, intents }) => ({ role, roleDetail, intents })),
	}),
)

export const StackAnswers = Schema.Struct({
	languages: Schema.Array(Schema.Literals(STACK_LANGUAGE_IDS)),
	platforms: Schema.Array(Schema.Literals(STACK_PLATFORM_IDS)),
})
export type StackAnswers = typeof StackAnswers.Type

export const NO_STACK: StackAnswers = { languages: [], platforms: [] }

export const QuickStartState = Schema.Struct({
	completedSteps: Schema.Record(Schema.String, Schema.Boolean),
	dismissed: Schema.Boolean,
	selectedFramework: Schema.NullOr(Schema.String),
	activeStep: Schema.String,
	qualifyAnswers: QualifyAnswers,
	stack: StackAnswers,
	checklistDismissed: Schema.Boolean,
	checklistExpanded: Schema.Boolean,
})
export type QuickStartState = typeof QuickStartState.Type

/** The old role, intent, team, plan wizard ended on its plan step: such a save stays finished. */
const isLegacyFinished = (completed: Readonly<Record<string, boolean>>): boolean =>
	("role" in completed || "intent" in completed) && completed.plan === true

const StoredQuickStartState = Schema.fromJsonString(
	Schema.Struct({
		...QuickStartState.fields,
		qualifyAnswers: StoredQualifyAnswers,
		stack: Schema.optionalKey(StackAnswers),
	}).pipe(
		Schema.decodeTo(QuickStartState, {
			decode: SchemaGetter.transform((stored) => ({
				...stored,
				stack: stored.stack ?? NO_STACK,
				completedSteps: isLegacyFinished(stored.completedSteps)
					? Object.fromEntries(STEP_IDS.map((step) => [step, true]))
					: stored.completedSteps,
			})),
			encode: SchemaGetter.transform((state) => state),
		}),
	),
)

export const DEFAULT_QUICK_START_STATE: QuickStartState = {
	completedSteps: {},
	dismissed: false,
	selectedFramework: null,
	activeStep: "plan",
	qualifyAnswers: { role: null, roleDetail: "", intents: [] },
	stack: NO_STACK,
	checklistDismissed: false,
	checklistExpanded: true,
}

/** Keyed by org, or `"default"` without one. */
export const storageKeyOf = (orgId: Option.Option<string>): string =>
	`maple-onboarding-v6-${Option.getOrElse(orgId, () => "default")}`

export const readQuickStartState = (key: string): Effect.Effect<QuickStartState> =>
	Effect.sync(() =>
		Option.getOrElse(
			Option.flatMap(readLocalStorage(key), Schema.decodeUnknownOption(StoredQuickStartState)),
			() => DEFAULT_QUICK_START_STATE,
		),
	)

export const writeQuickStartState = (key: string, state: QuickStartState): Effect.Effect<void> =>
	Effect.flatMap(Schema.encodeEffect(StoredQuickStartState)(state), (json) =>
		Effect.sync(() => writeLocalStorage(key, json)),
	).pipe(Effect.ignore)

/**
 * The step on screen: the saved one, else the first incomplete one. An org that already holds a
 * plan skips the plan step, wherever the save left off.
 */
export const resolveQuickStartStep = (state: QuickStartState, hasPlan: boolean): StepId => {
	const steps = STEP_IDS.filter((step) => !(hasPlan && step === "plan"))
	return (
		steps.find((step) => step === state.activeStep) ??
		steps.find((step) => state.completedSteps[step] !== true) ??
		"team"
	)
}

/** `completeStep(id)`: mark it done and, if it is the current step, move on to the next. */
export const completeStep = (state: QuickStartState, id: StepId, hasPlan: boolean): QuickStartState => {
	const index = STEP_IDS.indexOf(id)
	const next = STEP_IDS[index + 1]
	return {
		...state,
		completedSteps: { ...state.completedSteps, [id]: true },
		activeStep:
			resolveQuickStartStep(state, hasPlan) === id && next !== undefined ? next : state.activeStep,
	}
}

/** Onboarding is over once its last step is done. */
export const isQuickStartFinished = (state: QuickStartState): boolean =>
	state.completedSteps[STEP_IDS[STEP_IDS.length - 1] ?? "team"] === true

/** A finished save with no plan behind it: back to the plan step, and no longer finished. */
export const reopenedForPlan = (state: QuickStartState): QuickStartState => ({
	...state,
	activeStep: "plan",
	completedSteps: {
		...state.completedSteps,
		plan: false,
		[STEP_IDS[STEP_IDS.length - 1] ?? "team"]: false,
	},
})

/** New stack picks, and what the setup checklist derives from them (its intents and first snippet). */
export const withStack = (state: QuickStartState, stack: StackPicks): QuickStartState => ({
	...state,
	stack: { languages: [...stack.languages], platforms: [...stack.platforms] },
	qualifyAnswers: { ...state.qualifyAnswers, intents: [...intentsOf(stack)] },
	selectedFramework: frameworkOf(stack),
})
