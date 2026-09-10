---
title: "Apdex alerts"
description: "How to set up an Apdex alert in Maple: pick the target latency T, choose the score worth paging for, scope and tune the rule, and create the same rule over the API."
group: "Alerting"
order: 1
---

A p95 latency alert tells you that 5% of requests were slower than some number. It does not tell you whether that was 5 requests or 50,000, and it says nothing about the requests that failed outright.

**Apdex answers a different question:** of everything that hit this service in the last five minutes, what share of it was <span class="hl-ok">fast enough to keep a user happy</span>?

<div class="my-7 grid gap-3 sm:grid-cols-2 not-prose">
  <div class="rounded-lg border border-border p-4" style="background: color-mix(in oklab, var(--bg-elevated) 45%, transparent)">
    <div class="text-[10px] uppercase tracking-wider" style="color: var(--muted-foreground)">A p95 alert says</div>
    <div class="mt-2 text-sm text-fg">“The slow 5% crossed 1 second.”</div>
    <div class="mt-2 text-xs text-fg-muted">Shape of the tail. Silent when requests fail fast.</div>
  </div>
  <div class="rounded-lg border p-4" style="border-color: color-mix(in oklab, var(--primary) 45%, var(--border)); background: color-mix(in oklab, var(--primary) 8%, transparent)">
    <div class="text-[10px] uppercase tracking-wider" style="color: var(--primary)">An Apdex alert says</div>
    <div class="mt-2 text-sm text-fg">“One request in five was slow or broken.”</div>
    <div class="mt-2 text-xs text-fg-muted">Size of the tail, counting failures as unhappy users.</div>
  </div>
</div>

This page covers how to choose the one input that decides everything about the score, and how to turn it into an alert rule in Maple. For the score itself, start with the [What is Apdex?](/guides/what-is-apdex) guide.

<div class="my-6 grid gap-3 sm:grid-cols-3 not-prose">
  <div class="rounded-lg border border-border p-4" style="background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
    <div class="text-[10px] uppercase tracking-wider text-fg-muted">The score</div>
    <div class="mt-1.5 font-mono text-sm" style="color: var(--primary)">(A + 0.5B) / C</div>
    <div class="mt-1 text-xs text-fg-muted">Satisfied, half-credit tolerating, over total.</div>
  </div>
  <div class="rounded-lg border border-border p-4" style="background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
    <div class="text-[10px] uppercase tracking-wider text-fg-muted">Maple's default T</div>
    <div class="mt-1.5 font-mono text-sm" style="color: var(--primary)">500ms</div>
    <div class="mt-1 text-xs text-fg-muted">Frustrated follows automatically at 4T, so 2s.</div>
  </div>
  <div class="rounded-lg border border-border p-4" style="background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
    <div class="text-[10px] uppercase tracking-wider text-fg-muted">Usual alert line</div>
    <div class="mt-1.5 font-mono text-sm" style="color: var(--destructive)">&lt; 0.80 for 5 min</div>
    <div class="mt-1 text-xs text-fg-muted">The <strong>Low Apdex score</strong> template in Maple.</div>
  </div>
</div>

## The score in one line

Apdex compresses a latency distribution into a single number between <span class="hl-bad">0</span> and <span class="hl-ok">1</span>: the share of requests that were fast enough to keep a user happy. You set one target time, <span class="hl-t">T</span>. Requests under <span class="hl-t">T</span> are <span class="hl-ok">satisfied</span> and score a point, requests under <span class="hl-t">4T</span> are <span class="hl-warn">tolerating</span> and score half, and everything slower — plus everything that failed, at any speed — is <span class="hl-bad">frustrated</span> and scores nothing.

<div class="my-6 rounded-lg border border-border p-5 text-center not-prose" style="background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
  <div class="font-mono text-[15px] text-fg">Apdex = (satisfied + 0.5 × tolerating) / total</div>
  <div class="mt-2 text-xs text-fg-muted">Always between 0 and 1. Both boundaries come from the single value you set for T.</div>
</div>

Counting failures as frustrated is what makes this worth alerting on. A dependency that starts failing 15% of requests in 40ms makes your p95 *faster*, so a latency alert stays quiet while Apdex falls from 0.97 to about 0.83.

[**What is Apdex?**](/guides/what-is-apdex) walks through the formula, a worked example, and where Apdex and latency percentiles disagree. The rest of this page is the Maple-specific part: picking T for a rule, and building it.

## Choosing T for the rule

<span class="hl-t">T</span> is the whole rule. It sets the <span class="hl-ok">satisfied</span> boundary directly and the <span class="hl-bad">frustrated</span> boundary implicitly, since the <span class="hl-warn">tolerating</span> band always ends at <span class="hl-t">4T</span>. Move T from 500ms to 1s and you have also moved the frustrated line from 2s to 4s.

Pick T as the latency at which your users stop perceiving the response as immediate, per class of traffic:

<div class="my-6 overflow-hidden rounded-lg border border-border not-prose">
  <div class="grid gap-px sm:grid-cols-2" style="background: var(--border)">
    <div class="p-4" style="background: var(--background)">
      <div class="font-mono text-sm" style="color: var(--primary)">200ms – 300ms</div>
      <div class="mt-1 text-sm text-fg">Internal or service-to-service APIs</div>
      <div class="mt-1 text-xs text-fg-muted">They sit inside someone else's request, so their budget is small.</div>
    </div>
    <div class="p-4" style="background: var(--background)">
      <div class="font-mono text-sm" style="color: var(--primary)">500ms</div>
      <div class="mt-1 text-sm text-fg">User-facing API endpoints</div>
      <div class="mt-1 text-xs text-fg-muted">Maple's default, and a fair starting point for a JSON API behind a UI.</div>
    </div>
    <div class="p-4" style="background: var(--background)">
      <div class="font-mono text-sm" style="color: var(--primary)">1s – 2s</div>
      <div class="mt-1 text-sm text-fg">Full page loads and heavy reports</div>
      <div class="mt-1 text-xs text-fg-muted">Users accept more from something that visibly does more work.</div>
    </div>
    <div class="p-4" style="background: var(--background)">
      <div class="font-mono text-sm text-fg-muted">n/a</div>
      <div class="mt-1 text-sm text-fg">Background and batch endpoints</div>
      <div class="mt-1 text-xs text-fg-muted">Nobody is waiting. Alert on throughput or failure rate instead.</div>
    </div>
  </div>
</div>

> **Two ways to pick a T that tells you nothing.** Setting T to your current p95 guarantees a score near 0.95 forever. Setting it so tight that a healthy week already reads 0.6 buries every threshold you might pick inside your normal noise.

The honest way to choose is to open the service's Apdex chart in Maple, set T, and check that a healthy week reads somewhere in the 0.9 to 1.0 band. That leaves the 0.8 line meaningful.

## Choosing the threshold you defend

<div class="my-6 space-y-2 not-prose">
  <div class="flex items-center gap-3 rounded-lg border border-border px-4 py-3" style="background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
    <span class="w-[92px] shrink-0 font-mono text-sm" style="color: var(--success)">0.94 – 1.00</span>
    <span class="text-sm text-fg-muted">Healthy, with a normal slow tail.</span>
  </div>
  <div class="flex items-center gap-3 rounded-lg border border-border px-4 py-3" style="background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
    <span class="w-[92px] shrink-0 font-mono text-sm" style="color: var(--warning)">0.85 – 0.94</span>
    <span class="text-sm text-fg-muted">Degraded, and users can feel it.</span>
  </div>
  <div class="flex items-center gap-3 rounded-lg border border-border px-4 py-3" style="background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
    <span class="w-[92px] shrink-0 font-mono text-sm" style="color: var(--destructive)">below 0.80</span>
    <span class="text-sm text-fg-muted">The common alerting line. Roughly a fifth of traffic is frustrated or worse.</span>
  </div>
  <div class="flex items-center gap-3 rounded-lg border border-border px-4 py-3" style="background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
    <span class="w-[92px] shrink-0 font-mono text-sm" style="color: var(--destructive)">below 0.50</span>
    <span class="text-sm text-fg-muted">Most requests are failing or timing out.</span>
  </div>
</div>

0.8 is a convention, not a law. The number that matters is where your service sits when it is healthy, and how far it has to fall before you would want to be woken up.

## Setting up an Apdex alert in Maple

Maple computes Apdex over the entry-point spans of a service, which is to say the server and consumer spans and the trace roots, not every internal span. That is the same set of requests the service's Apdex chart draws, so a rule you build here matches what you saw on the chart that sent you looking.

### 1. Start from the Low Apdex score template

Open **Alerts → New rule**. Starting from a service page instead (**Services → your service → Create Alert**) pre-fills the scope.

The rule builder opens on **Start with a template**. Pick <span class="hl-t">Low Apdex score</span> and every field below is filled: signal Apdex, target 500ms, fires below 0.8, five-minute window. Nothing is locked afterwards.

<figure class="shot">
  <img src="/screenshots/docs/apdex-01-template.webp" alt="The Start with a template dialog in Maple's rule builder, with the Low Apdex score template reading “Apdex < 0.8 / 5min (target 500ms)”." loading="lazy" />
  <figcaption>The Low Apdex score template. Every value it sets stays editable.</figcaption>
</figure>

### 2. Set the target, then the score you defend

<span class="hl-t">Apdex target (ms)</span> is your T: requests under it count as <span class="hl-ok">fully satisfied</span>, and the <span class="hl-bad">frustrated</span> line follows automatically at 4T. Then set **Condition** to `<` and **Threshold** to the score worth paging for, typically `0.8`.

The panel also states the measurement boundary: built-in signals read entry-point (root) spans only. A service that swallows failures on child spans and returns success from its entry point stays healthy here at any threshold, which is what **Raw SQL** rules are for.

<figure class="shot">
  <img src="/screenshots/docs/apdex-02-signal.webp" alt="The Signal & threshold panel with the Apdex chip selected, Apdex target 500 ms, condition less-than, threshold 0.8 and severity Warning." loading="lazy" />
  <figcaption>Apdex target 500&nbsp;ms, condition <code>&lt;</code>, threshold 0.8. (The decimal comma is the browser's locale, not a Maple setting.)</figcaption>
</figure>

### 3. Scope it, and group it if one rule covers many services

Leave **Services** empty to watch everything, or name the ones you own. **Environments** works the same way. A **Group by** of `service.name` or `attr.http.route` evaluates each group on its own, so you get one incident per offender instead of one blended average that never quite breaches.

<figure class="shot">
  <img src="/screenshots/docs/apdex-03-scope.webp" alt="The Scope panel of the rule builder, with Services, Environments, Group by and Exclude services fields." loading="lazy" />
  <figcaption>Scope and grouping. Empty means every service and every environment.</figcaption>
</figure>

### 4. Window, severity, destinations

Five minutes is the default evaluation **window** and works for most services. Anything from one minute up to 24 hours is allowed, but short windows on low-traffic services are noisy, because a handful of slow requests moves the ratio a long way.

**Evaluation timing** collapses to a summary line (`5min · 2× · renotify 30min`) until you open it. The three fields under it are what keep an Apdex rule from paging you at 3am; [Tuning the rule so it pages you less](#tuning-the-rule-so-it-pages-you-less) below says what each one does.

<figure class="shot">
  <img src="/screenshots/docs/apdex-04-timing.webp" alt="The severity toggle set to Warning, and the expanded evaluation timing row: window 5 minutes, 2 breaches to fire, 2 healthy checks to resolve, minimum 50 samples, renotify every 30 minutes." loading="lazy" />
  <figcaption>Severity and evaluation timing. The defaults shown are the ones the template sets.</figcaption>
</figure>

Pick a **Severity**, attach your [notification destinations](/docs/alerting/notification-destinations), and save.

Maple evaluates alert rules every minute. Each check aggregates the window you configured, so a five-minute window is a rolling five minutes re-scored every 60 seconds.

### Tuning the rule so it pages you less

Three fields do most of the work of keeping an Apdex rule quiet without making it blind:

- **Minimum sample count** (default 50) skips the check when the window did not see enough requests. Without it, a service with 4 requests at 3am can post an Apdex of 0.5 and page someone. Raise it on low-traffic services.
- **Consecutive breaches required** (default 2) makes a rule wait for two bad checks in a row before opening an incident. **Consecutive healthy required** does the same on the way out, so an incident does not flap closed on a single good minute.
- **No-data behavior** decides what an empty window means. `skip` leaves the rule silent, which is what you want for Apdex. `zero` treats no traffic as a score of 0, which will page you every night.

### Creating the same rule over the API

Every field in the form is a field on the API. Apdex rules require `apdex_threshold_ms`:

```bash
curl -X POST https://api.maple.dev/v2/alerts/rules \
  -H "Authorization: Bearer maple_ak_…" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Checkout Apdex below 0.8",
    "signal_type": "apdex",
    "apdex_threshold_ms": 500,
    "comparator": "lt",
    "threshold": 0.8,
    "window_minutes": 5,
    "service_names": ["checkout"],
    "environments": ["production"],
    "severity": "critical",
    "minimum_sample_count": 50,
    "consecutive_breaches_required": 2,
    "no_data_behavior": "skip",
    "destination_ids": ["dest_oybbpTBhtSFGShMjjLiCrh"]
  }'
```

`POST /v2/alerts/rules/preview` accepts the same body and returns what the rule would have done over a past window, which is the cheapest way to find out that your threshold is too tight before it wakes anyone. See the [API reference](/docs/api) for the full schema.

### Or hand it to an agent

If you already talk to your telemetry through an AI assistant, you can skip the form. Connect Maple's [MCP server](/docs/mcp) to Claude, Cursor, or any MCP client, then ask for the rule in plain language:

> Create an Apdex alert on the checkout service. Target 500ms, page me when the score drops below 0.8, and send it to the on-call Slack channel.

The agent builds the same rule you would have built by hand, under the same constraints: it cannot save an Apdex alert without a target, and it only ever sees your own organisation's data.

The connection stays useful after the rule exists. Ask which of your Apdex rules would never fire, or why one paged last night, and the agent can read the rule's history to answer. The [MCP page](/docs/mcp) has the setup steps.

## Known limitations

- **Apdex is computed on sampled spans.** If you sample at 10%, the score is the ratio measured across the requests you kept. That stays representative under uniform sampling, but a sampling policy that keeps slow or failed traces preferentially will drag the score down relative to reality.
- **One T per rule.** A service whose `/healthz` and `/reports/export` share a rule is being measured against a target that fits neither. Group by `attr.http.route`, or write separate rules.
- **The score hides magnitude.** It counts frustrated requests without weighting how frustrated they were. Pair it with a p99 rule.

More on the score itself — the formula, a worked example, what counts as a good score, and how it compares to p95 and p99 — is in the [What is Apdex?](/guides/what-is-apdex) guide.
