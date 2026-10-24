# Security Center: plan

Status, 2026-10-23: phases 0 to 2 are in a PR stack (`feat/security-audit-*`), internal-only.

- `packages/security-audit`: the vendored skill, its validators as the runtime contract, prompts
  assembled from its blocks, and the engine (the skill's parent as code).
- `apps/ai`: agents, read-only source tools, `bun run --cwd apps/ai security:local <repo-dir>`
  (phase 0), and `SecurityAuditWorkflow` (one durable step per agent).
- `packages/backend` + `packages/db`: the org-scoped store and its tables.
- No target code executes yet: execution-bound leads stay `needs_validation` until sandbox v2.

First measured run (quick, scoped to `apps/sandbox/src`, budget 10): 8 invocations, about 3.7M
input tokens, no findings, six real hardening notes; the upstream validators pass on its output.
Anthropic models stream a tool call with no arguments without its parameter end, which the agent
engine rejects, so every audit tool takes a required argument.

The Security Center is the place in Maple that keeps an organization secure across everything
Maple can see: source code, telemetry, and connected infrastructure. This document plans its
first module, the **deep code scan**: a scheduled, whole-repository vulnerability audit that
finds real, independently verified bugs, not lint.

## Baseline: Cloudflare's `security-audit` skill

The methodology is [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill)
(MIT, pinned at `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`), run in its **`deep` profile**. It is
the skill that seeded Cloudflare's own vulnerability discovery harness
([Build your own vulnerability harness](https://blog.cloudflare.com/build-your-own-vulnerability-harness)).
We adopt it as written and build the platform it assumes, rather than inventing our own method.

The six phases, as the skill defines them:

1. **Reconnaissance.** Four parallel research agents (product and stack; principals and controls;
   entry surfaces and sinks; local execution and deployment visibility), plus focused agents per
   distinct subsystem. The parent writes `architecture.md` (about 1,000 words max) and a
   deterministic `coverage-ledger.json`: one unit per material surface x boundary x subsystem x
   attack class (x lifecycle mode in `deep`), with stable `coverage_id`s derived from canonical
   source references.
2. **Coverage-led hunting waves.** One isolated hunter per unit (or a few related units). Each
   hunter prompt carries `architecture.md`, its units, and the selected attack-class blocks
   **copied verbatim** from `ATTACK-CLASSES.md` and the domain companions. Hunters return one JSON
   object: per-unit disposition (`covered` | `candidate` | `blocked`), the checks they ran,
   candidates, hardening notes, and `uncovered` surfaces. After each wave a fresh **coverage
   critic** proposes missing units and reassignments. In `deep`, waves repeat until a post-wave
   critic and a separate final-clean critic both return no work.
3. **Candidate validation.** Every unique fingerprint goes to a fresh verifier that did not hunt
   it, is told to refute it, re-reads every cited line, and reproduces the result itself.
   Verdict: `confirmed`, `needs_validation` (an exact blocker, no severity) or `rejected`.
4. **Structured output.** `findings.json` against `report-schema.json`, checked by
   `validate-findings.cjs` and `validate-coverage-ledger.cjs`.
5. **Independent record verification.** Another fresh verifier per final record. A material
   replacement (stronger verdict, changed root cause, trace, impact or severity) needs yet another
   fresh verifier before it applies.
6. **Report.** Derived from the verified records and the ledger only.

The rules that make it deep, all kept:

- A finding needs a lower-trust principal, a crossed boundary, an affected resource and an
  observed result. Defense-in-depth gaps and checklist deviations are hardening notes.
- The agent that checks a finding never found it. Severity only on `confirmed`, never above the
  demonstrated impact.
- Coverage is the ledger, not prose. A unit closes only with reviewed paths and checks.
- Runs are additive: the next run reads prior ledgers and findings, carries unchanged confirmed
  records (re-verified), re-opens changed source, and turns prior gaps into current work.
  Cloudflare measured that one run finds about half of what repeated runs find. **The scheduled
  cycle is how we get the other half.**

### What Cloudflare learned scaling it (from the post)

Built into this plan, not rediscovered:

- Use a different model for validation than for discovery. Keep the harness model-agnostic.
- Persistence before parallelism: every stage result goes to the database as it arrives.
- Keep live context under about 25% of the window; the ledger is the external memory.
- Require a proof-of-concept test that runs against the **untouched** code. Hunters edited source
  to make exploits work and wrote tautological tests until this was enforced.
- Classify model responses explicitly: a transient API error can arrive as text in a `200 OK`.
- Static analyzers bolted on as tools went unused ("invoked zero times in a month"). We do not
  build them first.
- Flag shallow runs (zero findings, thin checks) and requeue them.
- Dedup is deterministic indexing first (files, functions, boundaries, rare tokens), an agent only
  over the short candidate list. Stable cross-run keys reopen records instead of duplicating.
- Their numbers for calibration: a ~30k LOC repo gave ~100 raw, 80 distinct, ~10
  critical/high/exploitable findings in about 3 hours; the worst fleet run took just over 14
  hours; validation rejection fell from 40% to 11% as hunters improved.

## Scale: Maple is 28x their benchmark

Maple is about 840k lines of non-test source. One `deep` run over all of it is likely thousands
of agent invocations and well over a day. So the cycle is a **rolling deep audit**:

- **Baseline run** (once, then on demand): `deep` over the whole repo. Establishes the full ledger.
- **Rolling slices** (on the cycle, e.g. nightly): a `deep` _scoped run_ over the next slice of
  subsystems by priority. The skill records everything else `out_of_scope`, never `covered`, so
  every slice adds evidence to one growing ledger and a full rotation equals another full pass.
- **Change revalidation** (on push to the default branch, or daily): the skill's prior-run rules
  applied to the diff. Changed source behind a confirmed record or a covered unit becomes a
  `prior_*_changed_source` unit, and new entry surfaces get units. This is how findings close and
  regressions reopen.

Slice priority uses the skill's own ranking: lowest-trust surfaces first, most valuable boundaries
(credentials, cross-tenant data, code execution, release authority), then prior gaps and changed
source.

## What already exists

| Piece              | Where                                              | Role in the scan                                                            |
| ------------------ | -------------------------------------------------- | --------------------------------------------------------------------------- |
| Repository sandbox | `apps/sandbox`, `@maple/backend/sandbox/contract`  | Checkout at a sha, mirror + R2 seed, `env -i`, unprivileged, read-only tree |
| GitHub App         | `vcs_repositories`, `GithubAppClient.mintCloneUrl` | One-repo, read-only clone tokens, never in argv                             |
| Agent engine       | `apps/ai/src/chat/*`, `@yielded/agent`             | Agent records, budgets, rulesets, close-out, Code Mode                      |
| Durable runs       | `durableStep`, `ClickHouseSchemaApplyWorkflow`     | Workflow per run, per-step retries, survives deploys                        |
| Findings plumbing  | `FindingEmbedder`, PR review findings lifecycle    | Similarity for dedup, dismissals                                            |
| Scheduling         | `apps/alerting/src/scheduled.ts` tick dispatch     | Cron tick that finds due work                                               |
| Traces             | warehouse, `route_usage`, `service_map`            | Production reachability (see below)                                         |

## Architecture

The skill's **parent** is trusted code: a Cloudflare Workflow (`SecurityAuditWorkflow`, apps/ai).
It is the only writer of shared state, exactly as the skill requires. Every agent invocation is one
durable step that returns a structured result; the parent validates it and updates the ledger.

```
cron / push ──► SecurityAuditService.dueRuns() ──► Workflow instance `audit-<target>-<sha>-<slice>`
  setup       pin sha, load prior ledger + findings, write run-metadata, budget gate
  prepare     sandbox checkout; trusted dependency install (lockfile only, scripts off)
  recon       4 research agents + focused agents (parallel) ──► architecture.md, ledger seed
  hunt        wave: N hunters in parallel (worker pool) ──► ledger update per result
              post-wave critic ──► missing units / reassignments ──► next wave
              final-clean critic ──► done when it returns nothing
  validate    fresh verifier per fingerprint (validation model) ──► confirmed | needs_validation | rejected
  verify      fresh verifier per final record; material replacement ──► another fresh verifier
  dedup       deterministic index over prior org findings, agent only on the shortlist
  judge       production reachability from Maple telemetry (our addition, no severity change)
  report      REPORT / FINDINGS-DETAIL / NEEDS-VALIDATION from records; notify
```

### Vendoring the skill

`packages/security-audit/` holds the upstream files unchanged under `skill/` with the pinned
commit and license, plus our code:

- **Prompt assembly**: builds hunter, critic and verifier prompts from the verbatim blocks the
  ledger unit names (`ordinary_attack_class_block`, `selected_companion_blocks`), as the skill's
  required prompt order specifies. A test fails if an assembled prompt is missing a selected block
  or paraphrases one.
- **Ledger and findings schemas** as Effect Schema, mirroring `report-schema.json` and the ledger
  state table. The upstream `validate-*.cjs` and their test fixtures run in CI as a parity gate
  against our schemas, so an upstream bump that tightens the contract fails loudly.
- An upgrade is a pinned-commit bump plus the parity gate, the same way we treat library updates.

### Agent invocations

Each recon agent, hunter, critic and verifier is a separate agent with its own record in
`agents.ts`-style definitions (`audit-recon`, `audit-hunter`, `audit-critic`, `audit-verifier`), its
own read-only ruleset, and the existing sandbox tools plus a new `sandbox_run` for bounded
execution (below). Results are structured output decoded at the step boundary; a malformed or
prose-wrapped result is discarded and re-run with a fresh agent, never repaired (skill rule).

Runtime limits: an invocation is bounded (target 20 minutes, under `TURN_STALE_MS` = 25 min) and
the depth comes from many invocations, not long ones. Whether invocations run inside the Workflow
step or in a per-invocation Durable Object (for transcripts and heartbeats like `ChatSession`) is
the first spike in phase 0.

Models: discovery and validation on **different** frontier models, both resolved per stage. The PR
review eval showed flash-class models catch 0/5 seeded bugs; they are not candidates here.

### Sandbox v2: execution the skill will accept

The skill only executes target code in an OS-enforced sandbox with **all** of: no external
network (isolated loopback allowed), an empty allowlisted environment, a read-only target and
toolchain, writes only to the agent's own `scratch/`, and explicit CPU, memory, process,
file-size, disk and wall-clock limits. Evidence leaves scratch only through **trusted parent-side
promotion** (no-follow descriptor walk, regular file, link count one, size bounds; the skill's
11-step procedure). Missing any of it, every candidate that needs execution stays
`needs_validation`. This is the difference between deep and very deep, so it is a core workstream:

| Control           | Today                                                                    | Needed                                                                                                                |
| ----------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| No egress         | `unshare -n`, fails closed, `CAP_SYS_ADMIN` on Cloudflare **unverified** | Verified on the real runtime, or platform egress deny                                                                 |
| Empty environment | `env -i` with an allowlist, verified in image                            | Keep; scratch-local `HOME`, `TMPDIR`, caches                                                                          |
| Read-only target  | `chmod -R a+rX,go-w` + `runuser`                                         | Keep; toolchain and `node_modules` read-only too                                                                      |
| Per-agent scratch | none                                                                     | `/audit/<run>/agents/<id>/scratch`, owned by the agent uid, nothing else writable                                     |
| Resource limits   | `timeout` only                                                           | `prlimit`/`ulimit`: CPU, address space, nproc, fsize, plus a disk quota                                               |
| Promotion         | none                                                                     | A small trusted helper in the image, run as root after the agent's processes exit, implementing the 11 steps verbatim |
| Dependencies      | none installed                                                           | Trusted prepare step: lockfile install with lifecycle scripts disabled, before any agent runs, then read-only         |

`verify:image` grows a case for each control (an escape attempt per row), and the phase gate is
that it passes on the deployed Cloudflare runtime, not only in local Docker.

PoC discipline from the post: a `confirmed` record's reproduction is a test that fails against the
untouched checkout. The verifier runs it itself in a fresh scratch copy.

### Production reachability (our addition)

Cloudflare's validation system has a "Judgment" stage that asks whether a finding is reachable in
production, using wiki, Jira, git and config. Maple has the traces. After verification, a
`judge` step joins each confirmed record's entrypoint to telemetry: requests to the route in the
last 7 days, distinct callers, whether the service is deployed, error and auth-failure shapes on
that path. It ranks and annotates. It never changes a verdict or severity, which stay the skill's
evidence-bound call.

### Data model (Postgres, `packages/db/src/tables/security.ts`)

- `security_audit_targets`: org, repository, branch, cadence (baseline, slices, revalidation),
  budget (max agent invocations per run and per month), enabled.
- `security_audit_runs`: target, sha, profile, scope paths, kind (`baseline` | `slice` |
  `revalidation`), workflow instance id, status (`in_progress` | `complete` | `incomplete` + reason),
  invocations planned/spent, timings, cost.
- `security_coverage_units`: the ledger, one row per `coverage_id` per run, with the skill's state
  table enforced (status, owner, reviewed paths, checks, fingerprints, unresolved, attempts).
- `security_findings`: one row per fingerprint per target across runs: current verdict, severity
  and confidence (confirmed only), the schema-typed record (jsonb), first/last seen sha and run,
  status (`open` | `fixed` | `dismissed` | `accepted_risk`), reachability annotation.
- `security_finding_events`: verdict changes, carries, regressions, dismissals, fixes.

Agent transcripts, `architecture.md`, promoted artifacts and the generated reports go to R2,
referenced from the rows. Findings are org-admin only (new `security:read` scope for keys); secret
values never leave the sandbox; nothing with exploit detail is posted to a public GitHub surface.

## Cost

The skill measures budget in agent invocations, so we do too, and `run-metadata.budget` is
enforced by the Workflow with the skill's reservation order (critics and validation reserved
before any hunter). Rough shape for one Maple slice: 4-8 recon, 40-150 hunters across 2-4 waves,
2 critics per wave, 1-2 verifiers per candidate. A baseline over all of Maple is likely
1,500-4,000 invocations. Dollars depend on the models and are measured in phase 0, not guessed
here.

## Phases

### Phase 0: run the skill as-is, measure (no new infrastructure)

1. Run the unmodified skill in `deep` profile locally (Claude Code, Opus 5.5) over **scoped slices
   of Maple** at the parent sha of known fixes: the security stacks #711-#719, #1674-#1678,
   #1683-#1687, and the 21 real defects from the deepsec sweep. Score which known bugs land as
   `confirmed` or `needs_validation`. This is our labelled set; Cloudflare had none.
2. Record invocations, wall clock, tokens and cost per slice, and how many candidates stayed
   `needs_validation` only because execution was unavailable.
3. Spike: one hunter as a Workflow step vs a Durable Object; one invocation on each candidate model.

Exit: the skill finds a meaningful share of the known bugs, and we know the cost per slice.

### Phase 1: sandbox v2

Every row of the sandbox table, verified by `verify:image` on the deployed runtime. Nothing in
phase 2 executes target code until this passes.

### Phase 2: the harness, manual trigger, internal org

`packages/security-audit` (vendored skill, prompt assembly, schemas, parity gate), tables and
migration, `SecurityAuditWorkflow` with all six phases, ledger persistence per result, budget
gate, shallow-run requeue, `security:local` runner for the same pipeline over a local clone. Run
the baseline on `MapleTechLabs/maple` and hand-triage the result before anything else.

### Phase 2.5: customer readiness

The method is language-neutral; the platform around it is not. Before a customer repo is scanned:

- **Multi-language eval.** Phase 0 only measures Maple (TypeScript). Add public repos with
  published security advisories and known fix commits in each main language (Python, Go, Rust,
  Java, plus JS/TS outside Maple), scored the same way at the parent sha of each fix.
- **Toolchain images.** Recon picks a per-ecosystem sandbox image (node/bun today; add Python,
  Go, Rust, JVM). A repo without a matching image runs source-only, and the report says so.
- **Dependency tiers.** Public lockfile dependencies go through the trusted prepare install. Private
  registries, private submodules and internal packages have no credentials, so those repos fall
  back to source-only, with execution-bound candidates labelled `needs_validation`.
- **Hostile-code isolation.** Customer code is untrusted in a way Maple's is not. Sandbox v2 gets
  an external review and cross-tenant escape tests (one org's scan cannot reach another org's
  checkout, scratch or artifacts) before any customer code executes.
- **Metering.** Per-org invocation budgets, Autumn billing source `security_audit`, cycle cadence
  and slice size sized to the plan, hard stop between steps. Large monorepos get slower rotations,
  never silent truncation.
- **Size limits.** Checkout size and history depth checks at prepare (LFS, very large repos); a
  repo that does not fit is refused with a reason, not partially scanned and reported as covered.

**Phase 2.5 status, 2026-10-24.** Landed (platform parts, branch `feat/security-audit-readiness`):

- **Metering.** An org's monthly invocation budget is its plan's `security_audit_invocations`
  allotment (Autumn; unmetered orgs get `SECURITY_AUDIT_UNMETERED_MONTHLY_INVOCATIONS`).
  `startRun` refuses with a 402 when the org cannot fund the profile's minimum and caps the run's
  budget at what the org has left. Before every agent step the Workflow reserves one invocation
  in `security_audit_org_usage` (conditional upsert, open runs only) and tracks it to Autumn with
  source `security_audit`; a refusal ends the run `incomplete` with `org_budget_exhausted`.
  Reports name every unit a run did not audit. The budget period is the subscription's own
  billing cycle (the UTC month only when billing gives none), and a start is also capped by
  Autumn's own remaining balance. Known gap: the Autumn track is fire-and-forget, so charges are
  lost while Autumn is down; reconcile them later from `security_audit_org_reservations`. A run
  that crosses a billing-cycle boundary keeps reserving against the period it started in, so it
  can spend past the new cycle's start; that overspend is bounded by the run's own budget. Slice
  size and cadence per plan wait on phase 3.
- **Size limits.** Target creation and run start refuse a repository GitHub reports as over
  `SECURITY_AUDIT_MAX_REPOSITORY_BYTES`, before any clone. After the clone, prepare measures
  commits, tracked files and bytes, and Git LFS files; a repository over a limit
  (`security-audit/limits.ts`, env-overridable) is refused and the run is marked failed with the
  reason.
- **Execution label.** Prepare detects ecosystems (node/bun, Python, Go, Rust, JVM) and private
  dependency signals (registries, credentials, submodules, local `replace`, SSH git deps) and
  stores an `executionProfile` on the run; every run is `source_only` with reasons, shown in the
  reports and on the run page.
- **GitHub only.** Targets resolve only through an active GitHub-connected repository.

Waits on phase 1 (sandbox v2): per-ecosystem toolchain images, the trusted dependency install,
hostile-code isolation with its external review and cross-tenant escape tests, and so any
`executable` run. The multi-language eval is not started.

What we can honestly ship at the end of this phase: full deep scans for JS/TS repos without
private dependencies, and source-only deep review for everything else with execution-bound
findings clearly labelled. GitHub only until another `VcsProviderId` exists. Cross-repo tracing
waits until customers' findings show attack paths crossing repositories.

### Phase 3: the cycle

Targets with cadences, rolling slices, push-triggered revalidation, carry-forward of prior records,
fixed/regressed detection, deterministic dedup, notifications through alert destinations for new
confirmed high/critical findings.

### Phase 4: Security Center UI and reachability

`/security` in `apps/web`: Overview (coverage over time from the ledger), Findings (trace, PoC,
verifier verdicts, reachability), Needs validation (owner checks), Runs (ledger and spend),
Settings. The `judge` step.

### Phase 5: fixing

The post's Fixer: apply a patch, the PoC test must flip fail-to-pass, the branch is opened for a
human and never merged automatically. Reuses the PR reviewer's `propose_edit` and Git Data API path.

### Later modules (separate plans)

Telemetry scans (secrets and PII in spans and logs, auth anomalies), runtime dependency CVEs from
resource attributes, infrastructure posture through the connected integrations.

## Open decisions

1. Phase 0 model and spend ceiling: a scoped deep slice of Maple on Opus 5.5 could run to hundreds
   of dollars. Which slices, and what cap?
2. Execution in the sandbox is what makes this very deep. If `CAP_SYS_ADMIN` is not available on
   Cloudflare Containers, do we accept platform egress controls as the "no external network"
   control, or move audit execution to a runtime we control?
3. Trusted dependency install in prepare (lockfile, scripts off) so hunters can run tests: accept
   the install-time exposure, or source-only for repos without a vendored toolchain?
4. Customer product from phase 2.5 behind a flag, or internal-only until the cycle and UI exist.
