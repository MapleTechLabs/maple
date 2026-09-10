/**
 * The tools a headless pass answers *through*.
 *
 * A pass emits events, not objects, so its structured answer arrives as the parameters of a
 * required completion tool: the model filling the schema in is the model answering.
 *
 * Declared here, once per answer shape, rather than built inside `runAgentPass`. Two reasons, and
 * both are about types rather than taste:
 *
 *   - A tool's name has to be a **literal** for its handler map to typecheck against its own
 *     toolkit. Built from a runtime string, the map is `{ [x: string]: handler }` and no longer
 *     satisfies the toolkit it belongs to.
 *   - `parameters` is the answer's Effect Schema, not JSON Schema, so the engine decodes and
 *     validates the model's answer and hands a schema error back for it to retry. A dynamic tool
 *     would leave that decode to us, after the run had already accepted the call.
 *
 * The handlers are a formality. A completion call is projected into the run's output rather than
 * dispatched, so one only runs if a model calls the tool as an ordinary one mid-run.
 */
import { AiTriageResult, InvestigationPlan, LensCandidate, ValidatorVerdict } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { MapleToolFailure } from "@/mcp/tools/llm-tools"
import { PLANNER_SUBMIT_DESCRIPTION, PLANNER_SUBMIT_TOOL } from "./planner-prompt"

/** What a model is told when it calls a submit tool as an ordinary one. */
const RECORDED = "Recorded."

const recorded = () => Effect.succeed(RECORDED)

const CANDIDATE_DESCRIPTION =
	"Record your candidate. Call it exactly once, after you have gathered evidence. If your " +
	"hypothesis did not hold, still call it — say in `claim` what you checked, what you saw " +
	"instead, and what would have convinced you. A lane that reports an honest negative is doing " +
	"its job; one that reports nothing is indistinguishable from one that never looked."

const DIAGNOSIS_DESCRIPTION =
	"Record the diagnosis. Call it exactly once, after you have gathered evidence. This is " +
	"published as the investigation's report, so `ruledOut` is what tells the reader what else " +
	"you considered — fill it even when you are confident, and especially when you are not."

const VERDICT_DESCRIPTION =
	"Record your ranking. Call it exactly once — this call IS your answer, and prose outside " +
	"it is discarded. Promoting nothing is a legitimate outcome: leave promotedLensId null " +
	"and still submit a `report` as a partial, saying what was ruled out, what could not be " +
	"checked, and the strongest remaining lead at low confidence."

/** One ranked lane's candidate. */
const candidateToolkit = Toolkit.make(
	Tool.make("submit_candidate", {
		description: CANDIDATE_DESCRIPTION,
		parameters: LensCandidate,
		success: Schema.String,
		failure: MapleToolFailure,
	}),
)

export const submitCandidate = {
	name: "submit_candidate",
	schema: LensCandidate,
	toolkit: candidateToolkit,
	layer: candidateToolkit.toLayer({ submit_candidate: recorded }),
} as const

/** The collapsed path: one lane, publishing the report itself. */
const diagnosisToolkit = Toolkit.make(
	Tool.make("submit_diagnosis", {
		description: DIAGNOSIS_DESCRIPTION,
		parameters: AiTriageResult,
		success: Schema.String,
		failure: MapleToolFailure,
	}),
)

export const submitDiagnosis = {
	name: "submit_diagnosis",
	schema: AiTriageResult,
	toolkit: diagnosisToolkit,
	layer: diagnosisToolkit.toLayer({ submit_diagnosis: recorded }),
} as const

/** The plan the fan-out is dispatched from. */
const planToolkit = Toolkit.make(
	Tool.make(PLANNER_SUBMIT_TOOL, {
		description: PLANNER_SUBMIT_DESCRIPTION,
		parameters: InvestigationPlan,
		success: Schema.String,
		failure: MapleToolFailure,
	}),
)

export const submitPlan = {
	name: PLANNER_SUBMIT_TOOL,
	schema: InvestigationPlan,
	toolkit: planToolkit,
	layer: planToolkit.toLayer({ submit_plan: recorded }),
} as const

/** The ranking that decides what the run publishes. */
const verdictToolkit = Toolkit.make(
	Tool.make("submit_verdict", {
		description: VERDICT_DESCRIPTION,
		parameters: ValidatorVerdict,
		success: Schema.String,
		failure: MapleToolFailure,
	}),
)

export const submitVerdict = {
	name: "submit_verdict",
	schema: ValidatorVerdict,
	toolkit: verdictToolkit,
	layer: verdictToolkit.toLayer({ submit_verdict: recorded }),
} as const
