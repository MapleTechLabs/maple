# Alerting tier 1: severity tiers, recovery, N-of-M, change conditions, silences, incident actions

Status: proposal, 2026-10-16; PR 1 built (see "PR 1 as built"). Follows a survey of how other alerting
tools model thresholds, silences and incidents, and the Paper "Alerting rethink" designs,
which already assume warn + page thresholds, silences and incident ack/snooze.

## Goals

1. One rule carries a **warning** and a **critical** threshold. The incident's severity moves between them.
2. Each threshold can have its own **recovery value** (hysteresis by value, not only by tick count).
3. A rule opens after **N of the last M** checks breach, not only N in a row.
4. A rule can watch the **change** of a value against the same window 1h, 1d or 7d earlier.
5. **Silences**: one-off and recurring, scoped by rule, tag, group and severity. They mute notifications only.
6. **Incident actions**: acknowledge, snooze, resolve with a note. Assignee and notes reuse the linked issue.

Non-goals for tier 1: routing policies, notification grouping, per-group no-data, SLO burn rate, anomaly as a
rule condition, heartbeat monitors, per-rule check interval. They build on this model and come next.

## Current model (what changes)

- `alert_rules` has one `severity`, `comparator`, `threshold`, `threshold_upper` and `destination_ids_json`
  (`packages/db/src/tables/alerts.ts`).
- Evaluation is `evaluateAlertObservation` → breached / healthy / skipped (`packages/alerting-core/src/index.ts`).
- `planAlertLifecycle` folds that into consecutive counters through `IncidentHysteresis`
  (`packages/alerting-core/src/hysteresis.ts`) and decides opened / continued / resolved, renotify and flap
  suppression. The anomaly detector shares the same machine.
- `alert_incidents` is read-only to users: `open | resolved` plus the hold sub-state.

## 1. Rule model

### Schema (domain)

New struct in `packages/domain/src/http/alerts.ts`:

```ts
export const AlertThreshold = Schema.Struct({
	severity: AlertSeverity, // "warning" | "critical"
	value: Schema.Number,
	upper: Schema.optionalKey(Schema.NullOr(Schema.Number)), // range comparators only
	recoveryValue: Schema.optionalKey(Schema.NullOr(Schema.Number)), // null = recover when no longer breaching
	destinationIds: Schema.Array(AlertDestinationId),
})

export const AlertThresholds = Schema.Array(AlertThreshold).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(2),
)

export const AlertCompareTo = Schema.Struct({
	offsetMinutes: Schema.Literals([60, 1440, 10080]), // 1h, 1d, 7d
	mode: Schema.Literals(["percent", "absolute"]),
})
```

Rule document and upsert request:

- Add `thresholds: AlertThresholds`, `compareTo: NullOr(AlertCompareTo)`, `breachesOutOf: NullOr(PositiveInt)`.
- `comparator` stays rule-level. Both tiers share one direction, so "warn above 2%, page above 5%" reads
  naturally and the chart has one shaded side.
- `consecutiveBreachesRequired` keeps its column and meaning **N**. `breachesOutOf` is **M**: null means M = N,
  which is exactly today's "N in a row".
- Remove `severity`, `threshold`, `thresholdUpper` and `destinationIds` from the document. See Compatibility for
  how writes that still send them are handled.

Validation (upsert boundary, as `AlertValidationError` so bad input is a 400):

- At most one threshold per severity.
- With two tiers, critical must be strictly worse than warning in the comparator's direction
  (`gt`/`gte`: critical > warning; `lt`/`lte`: critical < warning).
- `recoveryValue` must sit on the healthy side of `value` (for `gt`: recovery < value). For `gte`/`lte`
  the boundary is inclusive the same way.
- `eq`, `neq`, `between`, `not_between`: one tier only, no `recoveryValue` in tier 1. Range tiers would need
  nested bands and a two-sided recovery. That is rare and can come later.
- `1 <= N <= M <= 30`.
- `compareTo` is rejected for `signalType = "raw_query"` in tier 1 (no stable way to shift the user's
  `$__timeFilter`, see 4). It is allowed with group-by.
- Every threshold needs at least one destination unless the rule is disabled. This keeps today's "unrouted"
  blind spot meaningful per tier.

### Postgres

`alert_rules` (additive migration first, see Rollout):

| column            | type             | notes                                                           |
| ----------------- | ---------------- | --------------------------------------------------------------- |
| `thresholds_json` | `jsonb not null` | `AlertThresholds`, schema-typed via `PG.jsonb(AlertThresholds)` |
| `breaches_out_of` | `int4 null`      | M; null = N                                                     |
| `compare_to_json` | `jsonb null`     | `AlertCompareTo`                                                |

Backfill in the same migration:

```sql
UPDATE alert_rules SET thresholds_json = jsonb_build_array(jsonb_build_object(
  'severity', severity, 'value', threshold, 'upper', threshold_upper,
  'recoveryValue', NULL, 'destinationIds', destination_ids_json));
```

A follow-up migration drops `severity`, `threshold`, `threshold_upper` and `destination_ids_json` once no
deployed code reads them. To verify before writing it: whether `db:generate` keeps a hand-added `UPDATE` in
`migration.sql`, and whether `parity.test.ts` accepts it.

`alert_rule_states` replaces the two counters with a short history:

| column            | type                           | notes                                                     |
| ----------------- | ------------------------------ | --------------------------------------------------------- |
| `active_severity` | `text null`                    | the tier currently active for this group, null when clear |
| `history`         | `int2[] not null default '{}'` | last M ticks, newest last, one code per tick (below)      |

Each tick code packs one 2-bit status per tier: `0 = clear`, `1 = hold` (between recovery and trigger),
`2 = breach`. So `code = warning | critical << 2`. Skipped ticks are **not** appended: as today, they count
as evidence of nothing.

`consecutive_breaches` / `consecutive_healthy` stay populated (derived from `history`) until the drop
migration, because `alert_checks` and the web read them.

Electric write-amplification: `alert_rule_states` is synced, and today's upsert is skipped when nothing
changed. A ring buffer shifts every tick, which would defeat that gate. Saturate it: when the last M codes are
all identical and the new code matches, the array is unchanged and the upsert is skipped. Steady healthy and
steady breaching rules (almost all of them) stay write-free. Only mixed histories write each tick, and those
are exactly the groups worth watching.

### Notification template variables

Add to `ALERT_TEMPLATE_VARIABLES`:

- `severity.previous` (empty unless the event is a severity change)
- `threshold.warning`, `threshold.critical`, `recovery` (formatted)
- `baseline` and `change.summary` (for example `+64% vs 1d ago`) when `compareTo` is set
- `ack.by` and `snooze.until`

`event.type` gains `escalate`, `deescalate` and `acknowledge` (see 2 and 6).

## 2. Evaluator

All decision logic stays pure in `@maple/alerting-core`. `AlertsService` stays the I/O adapter.

### Per-tick evaluation

`evaluateAlertObservation` becomes `evaluateTieredObservation(policy, observation)`. `policy` carries
`comparator`, the tiers, `minimumSampleCount` and `noDataBehavior`. The skip rules are unchanged: no_data,
below_min_samples and no_value still skip the whole tick. For a non-skipped value, each tier gets:

- `breach` when `compareAlertThreshold(value, comparator, tier.value, tier.upper)` holds.
- `clear` when it does not hold **and** (no `recoveryValue`, or the value is past `recoveryValue` on the
  healthy side).
- `hold` otherwise: inside the dead band.

No-data with `noDataBehavior = "alert"` marks **every** tier `breach`, so an absence rule pages at critical
when it has a critical tier. `"zero"` evaluates 0 as a value, as today.

The result keeps today's `status` for consumers: `breached` if any tier breaches, `healthy` if all are clear,
and `healthy` otherwise (a tick in the dead band is a healthy check row). The per-tier codes travel
alongside as `levels`.

### Lifecycle: `planTieredLifecycle`

Replaces `planAlertLifecycle` for rules. Input adds `history`, `activeSeverity` and the incident's current
severity, ack and snooze state. Per tier, after appending the tick code and trimming to M:

- **Activate** tier t when `count(code_t == breach over the last M) >= N`.
- **Deactivate** an active tier t when the last R codes are all `clear_t`
  (R = `consecutiveHealthyRequired`). `hold` neither counts toward recovery nor toward a new breach.

`activeSeverity` is the highest active tier. Transitions:

| from     | to               | transition    | event                                                                     |
| -------- | ---------------- | ------------- | ------------------------------------------------------------------------- |
| none     | warning/critical | `opened`      | `trigger` to that tier's destinations                                     |
| warning  | critical         | `escalated`   | `escalate` to critical destinations; also clears an ack (new information) |
| critical | warning          | `deescalated` | `deescalate` to the destinations that received critical                   |
| any      | none             | `resolved`    | `resolve` to every destination notified during the incident               |

Everything else carries over unchanged: renotify cadence (sent to the current tier's destinations), flap
suppression on re-open, the held-incident liveness gate for no-data recovery, and `allowNoDataResolution`.

The anomaly detector keeps using `foldObservation` untouched. Moving it onto the tiered machine is a later
cleanup, not part of tier 1.

### Delivery fan-out

The destinations for an event are the union of every tier at or below the current severity. Example:
critical tier → PagerDuty, warning tier → Slack. A critical incident goes to both, and a warning incident
goes only to Slack. This matches what people mean by "warn in Slack, page on critical" and avoids configuring
Slack twice. The upsert stores tier lists as given; the union is computed at send time.

Delivery keys stay `incidentId:destinationId:eventType:scheduledAt`, so a destination in both tiers is
notified once per event.

PagerDuty: open at warning sends `severity: warning`. Escalation re-sends `trigger` with the same `dedup_key`
and `severity: critical`. **To verify**: whether Events v2 updates severity on an existing alert or ignores
it. If it ignores it, escalation needs a second dedup key per severity.

### Incident row

`alert_incidents.severity` becomes the **current** severity (it is mutable from now on). Add `peak_severity`
(never decreases) for lists and stats. The open-incident unique index on `(org, rule, group)` is unchanged:
escalation updates the row and does not open a second incident.

### `alert_checks` (ClickHouse)

Add, appended at the end so the ADD COLUMN migration lines up:

- `Level LowCardinality(String) DEFAULT ''`: `ok | warning | critical | hold-warning | hold-critical`
- `BaselineValue Nullable(Float64)`: set when `compareTo` is on
- `SilenceId String DEFAULT ''`: set when a delivery from this tick was suppressed

`Threshold` keeps the warning tier's value (or the only tier's) so existing readers stay correct. Run
`bun run tinybird:manifest` and `bun run local-schema:bump alert-checks-tiers`.

### Preview / backtest

`AlertRulePreviewResponse` gains `thresholds` (in place of `threshold`/`thresholdUpper`/`comparator`
top-level fields, which become derived for one release). `AlertRulePreviewPoint` gains `level` and, with
`compareTo`, `baseline`. `AlertRulePreviewFiringSpan` gains `severity`, and a span splits whenever severity
changes. The replay in `rule-edit-impact.tsx` then shows "pages 3 times instead of 11" per severity.

## 3. N-of-M

This falls out of the history column above; there is no separate mechanism. Defaults keep today's behaviour
exactly: M = null = N, R = 2.

The live scheduler slides one minute per tick. With a 5-minute window, consecutive ticks overlap, so "3 of 5"
means 3 of the last 5 one-minute steps of a sliding 5-minute window. The editor copy must say "checks", not
"minutes of breach", to keep this honest.

## 4. Change conditions

With `compareTo`, the rule's value becomes the change:

- `percent`: `(current - baseline) / |baseline| * 100`
- `absolute`: `current - baseline`

Thresholds, recovery and tiers then apply to that number. "Changes by more than 50% either way" is
`not_between [-50, 50]`.

Evaluator:

- `evaluateRule` runs the same compiled plan twice: once for `[end - window, end]`, once for the same window
  shifted back by `offsetMinutes`.
- The baseline window is in the past and immutable. Cache it in the query-engine cache keyed by plan hash and
  window end with a TTL of the offset, so a 1-minute tick pays for at most one cold baseline query per
  window.
- Grouped rules join baseline and current by `groupKey`.
- Skip reasons gain `no_baseline`. It applies when a group has no baseline (a new service) or the percent
  baseline is 0. It is a skip, so it never opens or resolves anything.
- `minimumSampleCount` applies to both windows.

`raw_query` is excluded in tier 1: the user's SQL owns its time filter through macros, and shifting it means
rewriting `$__timeFilter` expansion in the compiler. The builder and built-in signals go through
`planEvaluateSource`, which already takes the window explicitly.

Preview: query the range a second time shifted by the offset and align the two series per bucket.

## 5. Silences

### Table `alert_silences` (Electric-published, low write rate)

| column                                   | type                     | notes                                          |
| ---------------------------------------- | ------------------------ | ---------------------------------------------- |
| `id`                                     | branded `AlertSilenceId` |                                                |
| `org_id`                                 | `OrgId`                  | tenant column                                  |
| `name`                                   | `text`                   | shown in UI and on suppressed deliveries       |
| `matchers_json`                          | `jsonb`                  | `{ ruleIds?, tags?, groupKeys?, severities? }` |
| `schedule_json`                          | `jsonb`                  | tagged union, below                            |
| `mute_resolve`                           | `bool default false`     | also suppress resolve notifications            |
| `created_by`, `created_at`, `updated_at` |                          |                                                |
| `cancelled_at`                           | `timestamptzMillis null` | soft end; cancelled silences stay for audit    |

Matching: the fields inside a matcher are ANDed, and the values inside one field are ORed. An empty matcher
is rejected, so nobody silences the whole org by accident. A whole-org silence must say so explicitly with
`{ all: true }`.

Schedule:

```ts
Schema.TaggedUnion({
  Once: { startsAt: timestamptzMillis, endsAt: timestamptzMillis },
  Weekly: {
    weekdays: Array(Literals(["mon","tue","wed","thu","fri","sat","sun"])),
    startTime: "HH:MM", durationMinutes: PositiveInt (<= 7 days),
    timezone: IANA string, until: NullOr(timestamptzMillis),
  },
})
```

Daily is `Weekly` with all seven days. Monthly and full RRULE wait until someone asks.

### Semantics

- Evaluation, state, incidents and `alert_checks` all continue. Only **outbound notifications** are
  suppressed: deliveries, chat posts and mobile push. This is the common default elsewhere, and it keeps
  backtests and incident history truthful.
- One gate, `resolveSilence(orgSilences, rule, groupKey, severity, nowMs)`, a pure function in alerting-core.
  It is called where `AlertsService` queues delivery events and where push is enqueued. Active silences are
  loaded once per org per tick.
- A suppressed event writes the incident's `suppressed_by_silence_id` and a timeline entry. No delivery row
  is created.
- When a silence ends and a matched incident is still open with a suppressed trigger, the next tick sends
  `trigger`. Without this, a page silenced during a deploy would never arrive.
- Escalation during a silence is suppressed too, unless the matcher's `severities` excludes critical. That is
  how "mute warnings during the deploy, still page on critical" is expressed.

## 6. Incident actions

### Ownership split

The linked error issue (`error_issues`, kind `alert`) already has an assignee, claim, comments and workflow
state, and it outlives individual incidents for the same rule and group. Duplicating them on the incident
would fork the source of truth.

- **On the incident** (episode-scoped): acknowledge, snooze, manual resolve.
- **On the issue** (persistent): assignee, notes and comments. The incident page reads and writes them
  through the existing issue endpoints.

### Columns on `alert_incidents`

`acknowledged_at`, `acknowledged_by`, `snoozed_until`, `snoozed_by`, `resolved_by` (`null` = system),
`resolution_note`, `peak_severity`, `suppressed_by_silence_id`.

### Table `alert_incident_events` (not synced, read via API)

`id, org_id, incident_id, type, actor_id null, at, data_json`

`type` is one of `acknowledged | unacknowledged | snoozed | unsnoozed | resolved_manually | escalated |
deescalated | silenced`. The incident timeline merges this with deliveries and checks, as it already merges
deliveries and holds. Each human action also goes to the org audit log.

### Behaviour

- **Acknowledge**: stops renotify. Sends `acknowledge` only to providers that understand it (PagerDuty Events
  v2 `acknowledge`, a reply in the chat thread). Escalation to critical clears the ack and notifies.
- **Snooze** `{ until }` (presets 30m, 1h, 4h, tomorrow 09:00 in the user's timezone): suppresses renotify and
  escalation notifications until `until`. If the incident is still open when the snooze expires, renotify
  fires on the next tick. Resolve during a snooze still notifies.
- **Resolve** `{ note? }`: sets `status = resolved`, `resolved_by` and `resolution_note`, resets the group's
  `history`, and sends `resolve`. If the signal is still bad, a new incident opens after N-of-M as usual.
  Flap suppression does **not** apply to a re-open after a manual resolve, because the human asked for a clean
  slate.

### API, MCP, web

- v2:
    - `POST /alert-incidents/{id}/acknowledge`
    - `/unacknowledge`
    - `/snooze` `{ until }`
    - `/unsnooze`
    - `/resolve` `{ note? }`
    - Typed errors for "already resolved" and "snooze in the past".
- MCP:
    - one `act_on_alert_incident` tool with `action: P.oneOf([...])`.
    - `create_alert_silence`, `list_alert_silences`, `cancel_alert_silence`.
    - `create_alert_rule` / `update_alert_rule` take `thresholds`, `compare_to`, `breaches_out_of`.
    - Output schemas in `packages/domain/src/mcp-outputs/`.
    - `registry.contract.test.ts` covers the new tools.

## 7. Editor and UI

Keep the dashboard query panel and the Built-in / Query builder / SQL switch exactly as they are (decided
2026-10-15). Changes sit below the query.

**Condition bar** (`rule-condition-bar.tsx`). Replace the severity radio and single threshold with tier rows:

```
When  [error rate]  [is above ▾]
  ● Warning   2 %    recover below  1.5 %    → #alerts-api
  ● Critical  5 %    recover below  4 %      → PagerDuty: api-oncall     [remove]
  + Add critical threshold
Compare to  [the value ▾ | change vs 1h / 1d / 7d ago]  [% | absolute]
```

- The destination picker moves from `notifications-section.tsx` into each tier row. The message template
  stays in the notifications section.
- `describeRuleCondition` produces one sentence across both tiers for the action bar, for example
  "Warn above 2%, page above 5% of error rate".

**Chart hero** (`rule-live-chart-hero.tsx`):

- Two threshold lines, warning amber and critical red, each draggable and writing back into the form.
- A recovery value shows as a dashed line with the dead band lightly shaded.
- Preview firing spans are coloured by severity.
- With `compareTo`, a toggle shows either value and baseline overlaid, or the change series against the
  thresholds.

**Noise section** (`rule-noise-section.tsx`):

- "Open after [N] of the last [M] checks". It reads "N checks in a row" when M = N.
- "Resolve after [R] healthy checks".
- Remind interval and no-data stay.

**Edit impact**: the replay splits counts per severity.

**Incident page**:

- Action bar: Acknowledge, Snooze menu, Resolve with an optional note.
- The rail shows the issue assignee with a reassign control.
- The timeline renders the new event types and the silence that muted a notification.

**Alerts hub**:

- Inbox: acknowledged and snoozed incidents drop below the unacknowledged ones and get badges.
- Routing tab: gains a Silences section for active, scheduled and recently ended silences, plus a create
  dialog with scope and schedule.
- Rule and incident pages get a quick "Silence this rule for 1h".

## 8. Compatibility

- The v2 public API is the contract that matters (`docs/api-v2.md`). For one release, a write without
  `thresholds` but with `severity` + `threshold` (+ `thresholdUpper`, `destinationIds`) is converted to a
  single tier, and responses also carry those legacy fields derived from the highest tier. Both are marked
  deprecated in the OpenAPI document. Then remove them in the same change as the column drop.
- The web and MCP move to `thresholds` immediately. Nothing internal reads the legacy fields after PR 2.
- Mobile reads alert incidents; `severity` keeps its meaning (current severity) and values, so no app change is
  required. `peak_severity` is optional to consume.

## 9. Rollout (PR sequence)

1. **Core + schema.**
    - alerting-core: `evaluateTieredObservation`, `planTieredLifecycle`, `resolveSilence` (pure), with
      table-driven tests.
    - The additive Postgres migration with backfill.
    - Domain schemas, the evaluator wired to tiers, history, recovery and N-of-M.
    - `alert_checks` columns, and preview with levels.
    - The API accepts both shapes. Behaviour for existing rules is identical, and a test pins that: one tier,
      M = N, no recovery.
2. **Editor**: tier rows, draggable lines, N-of-M controls, per-tier destinations, MCP params.
3. **Change conditions**: the second query with its cache, the `no_baseline` skip, preview baseline, the
   compare-to UI.
4. **Incident actions**: columns, the events table, the v2 endpoints and MCP tool, the incident page,
   PagerDuty ack.
5. **Silences**: the table, published to Electric, the gate in delivery and push, the "still firing after
   silence" trigger, the Routing tab UI and MCP tools.
6. **Cleanup**: drop the legacy columns and API fields, and derive nothing from them.

PRs 3, 4 and 5 are independent of each other once PR 1 lands.

## 10. Tests (behaviour, per test-slop rules)

- alerting-core:
    - N-of-M opens on the Nth breach inside M, and not on N spread over more than M.
    - Hold neither resolves nor reopens.
    - Escalation, de-escalation and resolve orders.
    - Skipped ticks are not appended.
    - Saturated history is byte-identical across steady ticks, which keeps the Electric gate.
- `AlertsService` with `createTestDb()`:
    - Fan-out union per severity, sending once to a destination present in both tiers.
    - Ack stops renotify, and escalation clears ack.
    - Snooze expiry renotifies.
    - Manual resolve then re-open is not flap-suppressed.
    - A silence suppresses delivery and push, the incident is still created, and a trigger is sent when the
      silence ends.
- Change conditions:
    - Grouped join.
    - A new group skips with `no_baseline`.
    - A zero baseline in percent mode skips.
    - A baseline cache hit within a window.

## PR 1 as built (where it differs from the sections above)

- **No new event types.** The iOS client decodes `AlertEventType` and `AlertIncidentTransition` as
  closed enums, so a new value would break it.
    - Escalation is delivered as `trigger` at the new severity, and de-escalation as `renotify`, both
      restarting the reminder clock.
    - Check rows record a severity change as `continued`, and the new `Level` column says which tier
      breached.
    - Planner transitions (`escalated`, `deescalated`) stay internal.
- **No `active_severity` column.** The current severity is the open incident's `severity`, so the state
  row only adds `history_json` (jsonb `number[]`, not `int2[]`).
    - A state row without a history is replayed from its counters inside `planAlertLifecycle`. A
      property test proves the result matches the old consecutive-count machine.
- **Legacy columns stay authoritative for pre-tier rows only.** `thresholds_json` is nullable and not
  backfilled: a null reads as one tier from `severity`/`threshold`/`destination_ids_json`, so an old
  worker editing a rule mid-deploy cannot leave a stale tier list behind. Writes keep those columns in
  step, and the drop migration backfills first.
    - `destination_ids_json` holds every tier's destinations, so the "destination in use" check is
      unchanged.
- **`peak_severity` is not backfilled.** `alert_incidents` is synced with full-row WAL, so rewriting
  history is churn. Null reads as the current severity.
- **v2 PATCH carries tiers forward.** Single-threshold fields edit a one-tier rule's tier in place,
  keeping its recovery value. On a two-tier rule they are rejected with a 400, never silently collapsed.
- **Notification routing.** Trigger and escalation reach every tier at or below the new severity.
  De-escalation and resolve also reach every tier up to the incident's peak; reminders only reach the
  current tier's.
- **Rule edits.** An edit that changes the comparator or a tier value resets the group's history and
  counters in the same transaction, so ticks judged against the old condition never count.
  An incident whose severity the rule no longer has reads as the tier the rule kept; the move is
  announced (escalation or de-escalation) on its first breaching tick, and resolves reach that tier.
- **Linked issue.** Opening at or escalating to critical raises a detector-set issue to critical.
- **Validation.** Tiers are strictly ordered even for `gte`/`lte`, and a critical recovery value may
  not sit past the warning threshold.
- **Preview spans start at the first breach** inside the last M checks, not `(N-1)` windows before the
  tripping one. The two only differ when a skipped window sits inside the run.
- **Template variables** (`severity.previous`, `threshold.warning`, ...) are not added yet; they land
  with the editor in PR 2.

## Open questions

1. Is an `info` tier worth adding now (some tools add `info`)? Proposal: no, two tiers cover warn/page.
2. Should ack auto-expire (PagerDuty's ack timeout re-triggers after N minutes)? Proposal: not in tier 1.
3. Should a silence be able to suppress incident creation as well ("detect but do not open")? Proposal:
   no; truthful history wins.
4. Does PagerDuty Events v2 update severity on a deduped trigger? This decides the escalation dedup-key shape.
