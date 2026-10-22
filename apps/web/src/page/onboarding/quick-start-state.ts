import { ONBOARDING_INTENT_IDS, type OnboardingIntent } from "../../lib/onboarding-intent"
import { ONBOARDING_ROLE_IDS, type OnboardingRole } from "../../lib/onboarding-role"
import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { Effect, Option, Schema, SchemaGetter } from "effect"

// The quick start wizard's progress in localStorage `maple-onboarding-v6-<orgId>`, with normalisation
// of older saves.

export const STEP_IDS = ["role", "intent", "team", "plan"] as const
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

export const QuickStartState = Schema.Struct({
	completedSteps: Schema.Record(Schema.String, Schema.Boolean),
	dismissed: Schema.Boolean,
	selectedFramework: Schema.NullOr(Schema.String),
	activeStep: Schema.String,
	qualifyAnswers: QualifyAnswers,
	checklistDismissed: Schema.Boolean,
	checklistExpanded: Schema.Boolean,
})
export type QuickStartState = typeof QuickStartState.Type

const StoredQuickStartState = Schema.fromJsonString(
	Schema.Struct({ ...QuickStartState.fields, qualifyAnswers: StoredQualifyAnswers }),
)

export const DEFAULT_QUICK_START_STATE: QuickStartState = {
	completedSteps: {},
	dismissed: false,
	selectedFramework: null,
	activeStep: "role",
	qualifyAnswers: { role: null, roleDetail: "", intents: [] },
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

/** `resolveQuickStartStep`: a removed active step resumes at the first incomplete one. */
export const resolveQuickStartStep = (state: QuickStartState): StepId =>
	STEP_IDS.find((step) => step === state.activeStep) ??
	STEP_IDS.find((step) => state.completedSteps[step] !== true) ??
	"plan"

/** `completeStep(id)`: mark it done and, if it is the current step, move on to the next. */
export const completeStep = (state: QuickStartState, id: StepId): QuickStartState => {
	const index = STEP_IDS.indexOf(id)
	const next = STEP_IDS[index + 1]
	return {
		...state,
		completedSteps: { ...state.completedSteps, [id]: true },
		activeStep: resolveQuickStartStep(state) === id && next !== undefined ? next : state.activeStep,
	}
}

export const toggledIntent = (answers: QualifyAnswers, intent: OnboardingIntent): QualifyAnswers => ({
	...answers,
	intents: answers.intents.includes(intent)
		? answers.intents.filter((item) => item !== intent)
		: [...answers.intents, intent],
})

export const pickedRole = (
	answers: QualifyAnswers,
	role: OnboardingRole,
	detail: string,
): QualifyAnswers => ({
	...answers,
	role,
	roleDetail: detail,
})
