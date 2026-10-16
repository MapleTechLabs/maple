// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
/**
 * Does the model actually follow the rules the prompt states?
 *
 * The scoring rules themselves are unit-tested in `diagnosis-scorers.test.ts`;
 * this is the half that needs a real model. What is exercised is concluding:
 * given an incident where nothing is checkable, does the investigator say so
 * *with what it checked*, or invent a cause? A bare "it's an unknown error" used
 * to be a fully compliant answer.
 *
 * The telemetry is handed to the model as prose rather than through live tools:
 * the tool-selection question is already covered by `mcp/__evals__`, and what is
 * under test here is the reasoning and the reporting discipline the prompts ask
 * for — which is exactly what nothing scored before.
 *
 * Gated like every other eval: skips without `OPENROUTER_API_KEY`, runs under
 * `bun run eval`, never as part of `bun run test`.
 */
import { Effect, Layer, Schema } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { INVESTIGATE_SYSTEM_PROMPT } from "../prompts"
import { describeEval, type Scorer } from "../../mcp/__evals__/harness"
import { evalModel } from "../../evals/model"
import { DIAGNOSIS_FIXTURES, type DiagnosisFixture } from "./diagnosis-fixtures"
import {
	scoreCauseMatch,
	scoreEvidenceGrounding,
	scoreUnknownDiscipline,
	type RuleScore,
	type ScoredReport,
} from "./diagnosis-scorers"

const modelLayer = () => {
	const { model, clients } = evalModel()
	return model.layer.pipe(Layer.provide(clients))
}

const byId = new Map(DIAGNOSIS_FIXTURES.map((fixture) => [fixture.id, fixture]))

const fixtureFor = (input: string): DiagnosisFixture => {
	const fixture = byId.get(input)
	if (!fixture) throw new Error(`no diagnosis fixture named ${input}`)
	return fixture
}

const Strings = Schema.Array(Schema.String)

/**
 * Mirrors `AiTriageResult`.
 *
 * Hand-written rather than imported: this suite exists to catch the prompt
 * drifting away from the contract, and deriving both from one source would let a
 * schema change silently move the target it is scored against.
 */
const Report = Schema.Struct({
	summary: Schema.String,
	suspectedCause: Schema.String,
	severityAssessment: Schema.Literals(["critical", "high", "medium", "low"]),
	affectedScope: Schema.String,
	evidence: Schema.Array(
		Schema.Struct({
			traceIds: Strings,
			logPatterns: Strings,
			relatedServices: Strings,
			note: Schema.String,
		}),
	),
	suggestedActions: Strings,
	confidence: Schema.Literals(["high", "medium", "low"]),
	ruledOut: Strings,
})

const encodeReport = Schema.encodeSync(Schema.fromJsonString(Report))
const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const diagnose = (input: string) => {
	const fixture = fixtureFor(input)
	const prompt = Prompt.make([
		{ role: "system", content: INVESTIGATE_SYSTEM_PROMPT },
		{
			role: "user",
			content: [
				"Your tool calls have already run. This is everything they returned:",
				"",
				fixture.context,
				"",
				`What your first calls established: ${fixture.scopeSummary}`,
				"",
				"Produce the diagnosis you would submit.",
			].join("\n"),
		},
	])
	return LanguageModel.generateObject({ prompt, schema: Report, objectName: "diagnosis" }).pipe(
		Effect.map((response) => ({ output: encodeReport(response.value), toolCalls: [] })),
		Effect.provide(modelLayer()),
		Effect.runPromise,
	)
}

/** A scoring rule as a harness scorer, resolving the fixture from the case's input. */
const rule = (
	name: string,
	apply: (report: ScoredReport, fixture: DiagnosisFixture) => RuleScore,
): Scorer => ({
	name,
	score: ({ input, output }) => {
		const report = decodeReport(output)
		return apply(typeof report === "object" && report !== null ? report : {}, fixtureFor(input))
	},
})

describeEval("investigation diagnosis", {
	data: DIAGNOSIS_FIXTURES.map((fixture) => ({ input: fixture.id })),
	task: diagnose,
	scorers: [
		rule("cause match", scoreCauseMatch),
		rule("evidence grounding", scoreEvidenceGrounding),
		rule("unknown discipline", (report) => scoreUnknownDiscipline(report)),
	],
	threshold: 0.75,
})
