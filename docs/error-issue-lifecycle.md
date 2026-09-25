# The error issue lifecycle

How an error goes from "something threw in production" to "fixed, and we checked".

This is the flow both humans and agents are meant to follow. If you are changing anything under
`packages/backend/src/services/errors/`, this page is the contract you are changing.

## The pieces

| Thing         | Where it lives                          | What it is                                              |
| ------------- | --------------------------------------- | ------------------------------------------------------- |
| Occurrence    | ClickHouse / Tinybird                   | One exception, one row. Never mutated.                  |
| Fingerprint   | `cityHash64(org, service, type, frames, message signature)` | The identity of an error _class_. |
| Candidate     | `error_fingerprint_candidates`          | A fingerprint seen, but not yet worth a row of its own. |
| **Issue**     | `error_issues`                          | The durable, assignable record. One per fingerprint.    |
| Incident      | `error_incidents`                       | A time-bounded flare-up _under_ an issue.               |
| Investigation | `investigations`                        | One AI diagnostic run. Zero or more per issue.          |
| Verification  | `error_issue_verifications`             | One post-merge "did that actually work?" check.         |

The exception comes from the first OTel `exception` event, or the status message when
there is no event. Only spans missing both fall back to `exception.*` span attributes,
then `error.type` / `error.message`, then `Unknown Error`. This keeps existing fingerprints
stable while separating previously unlabelled errors. The SQL in `error_events_mv`
(`packages/domain/src/tinybird/materializations.ts`) owns this precedence.

**An incident is a flare-up. An issue is the bug.** An issue can flare up ten times; it gets
fixed once.

## The flow

```
        occurrences
             │
             ▼
     ┌───────────────┐   below PROMOTION_MIN_OCCURRENCES: stays here,
     │   candidate   │   pruned by retention, notifies nobody
     └───────┬───────┘
             ▼
         ┌────────┐        the errors tick opens an incident and notifies
         │ triage │◄────┐  per the org's error notification policy
         └───┬────┘     │
             │          │  snooze expiry
   AI investigation     │
   (if the org enabled it)
             │          │
             ▼          │
        ┌─────────┐     │
        │  todo   │─────┤
        └────┬────┘     │
             ▼          │
      ┌─────────────┐   │
      │ in_progress │───┤   claimed: one lease, so two agents can't both fix it
      └──────┬──────┘   │
             ▼          │
       ┌───────────┐    │
       │ in_review │    │   a fix is proposed, a PR is attached
       └─────┬─────┘    │
             │ PR merges│
             ▼          │
       ┌───────────┐    │
       │ verifying │    │   nobody acts. Maple watches for a window sized by
       └─────┬─────┘    │   the issue's severity and its own pre-merge rate
             │          │
    ┌────────┼────────┐ │
    ▼        ▼        ▼ │
 verified  not_fixed  inconclusive
    │        │          │
    │        └──────────┴──► back to in_progress / in_review
    ▼
 ┌──────┐   low/medium/untriaged: closed automatically.
 │ done │   high/critical: the verdict is posted, a human closes it.
 └──┬───┘
    │ an occurrence from a build that postdates the fix
    ▼
┌───────────┐
│ regressed │  NOT `triage`. The issue remembers it was fixed once, so the
└───────────┘  next person doesn't fix the same bug a second time
```

`cancelled` and `wontfix` are the exits off to the side. `wontfix` takes an optional `snoozeUntil`
and wakes back into `triage` when it expires.

## Who owns which edge

Three actors move issues:

- **Humans and agents** move an issue through the states that record an _intention_: `triage`,
  `todo`, `in_progress`, `in_review`, `done`, `cancelled`, `wontfix`.
- **The errors tick** (every minute) owns `regressed`. It records an _observation_: this error
  fired from a build that was not running when it was resolved. It would overwrite any human
  claim to the contrary on its next pass.
- **The verification tick** (every minute) owns `verifying` and the exit from it.

`regressed` and `verifying` are therefore in `MACHINE_OWNED_WORKFLOW_STATES`: legal edges in
`WORKFLOW_TRANSITIONS` because the ticks travel them, but filtered out of every surface that lets
somebody _choose_ a state: the web state picker, the bulk bar, and the `transition_error_issue`
MCP tool, which rejects them with an explanation.

The source of truth is `WORKFLOW_TRANSITIONS` in
`packages/domain/src/http/errors.ts`. The MCP tool description is rendered from it at registration
time by `describeWorkflowTransitions()`, so the rules an agent is told can never drift from the
rules the server enforces.

## Where the AI enters

There are **three** places, each with a different job.

### 1. Auto-investigation on a new incident

Off by default; an admin opts in per org (`ai_triage_settings`). When an incident opens (first-seen
or regression), `maybeEnqueueTriage` starts an investigation, subject to a daily budget in runs and
in model passes (`maxRunsPerDay`, `maxPassesPerDay`; one investigation is one pass).

Three gates stand between an open incident and that pass, cheapest first, and every refusal lands
on the `maybeStartInvestigation` span as `maple.investigation.start_result`:

1. **The issue's own history** (`evaluateIssueGate`, no model). An issue past `triage`/`regressed`
   is somebody's already; one diagnosed within the last week (a day for alerts and anomalies) is
   answered already, unless the incident is a `regression`; a pass still under way answers for
   this flare-up too. This is where the repeats die: an error incident auto-resolves after thirty
   quiet minutes and the next occurrence opens a fresh one, so an issue firing on a retry cadence
   opened 83 incidents in five days and was diagnosed, identically, on fifteen of them.
2. **The decision model** (`IncidentClassifier` → maple-ai's `POST /internal/triage/classify`,
   Jev over OpenRouter). It answers what the incident is (`investigate` / `monitor` / `noise`),
   how bad, whether a customer noticed, and whether one of the service's recent diagnoses already
   explains it. `evaluateIncidentGate` skips confident noise (`noise`) and confident matches
   (`covered_by_prior`), never anything the detector called `high` or `critical`, and only ever
   raises the severity the run is seeded with. A skipped noise incident labels its issue's
   severity if nobody had, without escalating. No verdict (no binding, no token, a failed or
   slow call) always reads as investigate. A broken classifier must not become a policy of
   dropping incidents.
3. **The daily budget**, judged by the severity the classifier settled on, so the reserve for
   `high`/`critical` is reachable by an incident the detector left unclassified.

A manual start (`force`) passes the first two; the quota still applies.

The run is one turn of the investigate agent on the investigation's `ChatSession` Durable Object:
it gathers the evidence, tests the rival explanations itself, and closes on `submit_diagnosis`. A
pass that stops in prose or dies on a model error gets one close-out turn over its own tool
transcript; a pass that still files nothing is marked `failed` with `no_diagnosis`. The report's
`ruledOut` records the explanations it tested and dropped, which makes a conclusion readable a
week later. (Until 2026-09 this was a planner → hypothesis lanes → validator workflow;
the handoffs lost the evidence and most passes never reached a verdict.)

The result lands back on the issue as an `ai_triage` timeline event plus an applied severity.
Severity is what escalates, so an AI-set severity can page people (`issue_escalations`), gated on
the run's own confidence.

### 2. An agent working the issue over MCP

An external coding agent claims an issue, reads its timeline, fixes the bug, and attaches a PR.
The lease is what keeps two agents off the same bug; it renews on every action and is dropped when
the issue closes.

**Doing the work takes the claim.** `propose_fix` and a transition to `in_progress` both acquire
the lease. This fixes the flow's worst failure. For as long as claiming was a separate step an agent was merely _told_ to take, it was
never taken once: across 50 live issues in the internal org every `lease_holder` was null, and the
most common MCP error in the org was `Illegal transition from 'triage' to 'in_review'`, which is
`propose_fix` being rejected on an issue nobody had claimed. Agents responded by hand-walking
`transition_error_issue` instead, which "worked" and left the lease empty. A guarantee that depends
on an agent reading a rule is not a guarantee.

The agent-facing map of this flow lives in the `maple://instructions` MCP resource
(`apps/ai/src/mcp/resources/instructions.ts`), and the
`apps/ai/src/mcp/__evals__/issue-workflow.eval.ts` cases check a real model still picks these tools. Keep both in sync with
this page.

### 3. Post-merge verification

When a linked PR merges, the issue moves to `verifying` and a window opens. Its length comes from
the issue's severity band and its own pre-merge occurrence rate, so it is six hours for a noisy
error and days for a rare one.

When the window closes, the tick reads the warehouse first. **The deterministic evidence decides
most cases**: occurrences are split against `baselineVersionsJson`, a snapshot of the builds the
issue had been seen from at merge time. An occurrence from a build already in that set is an old
client still in the wild; one from a build absent from it is the fix demonstrably not working, and
that alone refutes the fix without asking an agent anything.

Only a _clean_ window goes to an agent, and it is asked the inverted question: "find anything
that contradicts this fix holding". That explains the mapping in
`verdictFromInvestigationStatus`, which reads backwards until you hold that question. An agent
that _establishes_ a cause means `not_fixed`, and an agent that finds nothing means `verified`.

An inconclusive verdict re-arms exactly one longer window and then gives up, so an issue can never
loop in verification without a human ever seeing it.

## Rules worth not re-deriving

- **Never make the claim a step an agent has to remember.** Any new tool that starts work on an
  issue takes the lease itself. See above for what happened when it did not.
- **An issue with a linked PR should not be closed by hand.** The merge opens the verification
  window and the verdict closes it. Closing early throws the check away.
- **`verified` does not always mean closed.** Low, medium and untriaged issues auto-close; high and
  critical get the verdict posted and wait for a human. The cost of a wrong auto-close scales with
  severity; the value of saving a click does not.
- **A regression is not a new bug.** `lastResolvedAt`, `regressionCount` and the `regressed` state
  exist so that the second person to pick up an issue knows it was fixed once already.
- **Versions are compared by membership, never by ordering.** `maple-cli` reports semver and the
  Workers report git SHAs; "newer than the fix" is not a question those strings can answer.
- **Severity has three sources with a precedence**: manual > ai > detector (`IssueSeveritySource`).

## The files

| Concern                                 | File                                                                  |
| --------------------------------------- | --------------------------------------------------------------------- |
| State machine, transitions, labels      | `packages/domain/src/http/errors.ts`                                  |
| Verification windows, verdicts          | `packages/domain/src/http/fix-verification.ts`                        |
| Transitions, leases, timeline events    | `packages/backend/src/services/errors/ErrorIssueWorkflowService.ts`   |
| The errors tick (incidents, regression) | `packages/backend/src/services/errors/error-tick-persistence.ts`      |
| Starting an investigation               | `packages/backend/src/services/errors/ai-triage-enqueue.ts`           |
| The gates in front of it                | `packages/backend/src/services/errors/investigation-gate.ts`, `IncidentClassifier.ts`, `apps/ai/src/triage/` |
| The investigate agent and its close-out | `apps/ai/src/chat/turn-runner.ts`, `apps/ai/src/chat/prompts.ts`      |
| Writing a diagnosis back                | `packages/backend/src/services/errors/apply-diagnosis.ts`             |
| PR links and verification windows       | `packages/backend/src/services/errors/IssueFixVerificationService.ts` |
| The verification tick                   | `packages/backend/src/services/errors/FixVerificationTickService.ts`  |
| What agents are told                    | `apps/ai/src/mcp/resources/instructions.ts`                           |
