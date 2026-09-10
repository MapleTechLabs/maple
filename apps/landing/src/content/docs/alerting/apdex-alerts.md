---
title: "Apdex alerts"
description: "What the Apdex score measures, how to pick the target latency T that defines it, and how to set up an Apdex alert in Maple so you get paged when the share of fast requests drops."
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

This page covers what the score actually is, how to choose the one input that decides everything about it, and how to turn it into an alert rule in Maple.

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

## What is the Apdex score?

Apdex (Application Performance Index) is an industry-standard measure of user satisfaction derived from response times. It compresses a latency distribution into a single number between <span class="hl-bad">0</span> and <span class="hl-ok">1</span>, where <span class="hl-ok">1</span> means every request was fast and <span class="hl-bad">0</span> means none of them were.

You pick one input, a target response time called <span class="hl-t">T</span>. Every request in the window then lands in one of three buckets, <span class="hl-ok">satisfied</span>, <span class="hl-warn">tolerating</span> or <span class="hl-bad">frustrated</span>, and that bucket decides how much credit that request earns:

<div class="my-6 not-prose">
  <svg viewBox="0 0 900 108" class="w-full h-auto" role="img" aria-label="A latency axis split into three bands: satisfied below T, tolerating between T and 4T, frustrated beyond 4T.">
    <rect x="0" y="14" width="300" height="34" rx="4" style="fill: color-mix(in oklab, var(--success) 26%, transparent); stroke: color-mix(in oklab, var(--success) 55%, transparent)" />
    <rect x="304" y="14" width="330" height="34" rx="4" style="fill: color-mix(in oklab, var(--warning) 24%, transparent); stroke: color-mix(in oklab, var(--warning) 55%, transparent)" />
    <rect x="638" y="14" width="262" height="34" rx="4" style="fill: color-mix(in oklab, var(--destructive) 22%, transparent); stroke: color-mix(in oklab, var(--destructive) 55%, transparent)" />
    <text x="12" y="36" style="fill: var(--foreground); font-size: 13px; font-weight: 500">Satisfied</text>
    <text x="316" y="36" style="fill: var(--foreground); font-size: 13px; font-weight: 500">Tolerating</text>
    <text x="650" y="36" style="fill: var(--foreground); font-size: 13px; font-weight: 500">Frustrated</text>
    <text x="288" y="36" text-anchor="end" style="fill: var(--muted-foreground); font-size: 12px">1 point</text>
    <text x="622" y="36" text-anchor="end" style="fill: var(--muted-foreground); font-size: 12px">½ point</text>
    <text x="888" y="36" text-anchor="end" style="fill: var(--muted-foreground); font-size: 12px">0 points</text>
    <line x1="0" y1="62" x2="900" y2="62" style="stroke: var(--border)" />
    <line x1="302" y1="56" x2="302" y2="68" style="stroke: var(--primary); stroke-width: 2" />
    <line x1="636" y1="56" x2="636" y2="68" style="stroke: var(--primary); stroke-width: 2" />
    <text x="302" y="86" text-anchor="middle" style="fill: var(--primary); font-size: 13px; font-weight: 600">T</text>
    <text x="636" y="86" text-anchor="middle" style="fill: var(--primary); font-size: 13px; font-weight: 600">4T</text>
    <text x="0" y="86" style="fill: var(--muted-foreground); font-size: 11px">0ms</text>
    <text x="900" y="86" text-anchor="end" style="fill: var(--muted-foreground); font-size: 11px">slower →</text>
  </svg>
</div>

<div class="grid gap-3 sm:grid-cols-3 my-6 not-prose">
  <div class="rounded-lg border border-border p-4" style="border-left: 3px solid var(--success); background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
    <div class="text-[10px] uppercase tracking-wider text-fg-muted">Satisfied · 1 point</div>
    <div class="mt-1.5 text-sm text-fg">Finished faster than <strong>T</strong>. The user got what they asked for and did not notice the wait.</div>
  </div>
  <div class="rounded-lg border border-border p-4" style="border-left: 3px solid var(--warning); background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
    <div class="text-[10px] uppercase tracking-wider text-fg-muted">Tolerating · ½ point</div>
    <div class="mt-1.5 text-sm text-fg">Between <strong>T</strong> and <strong>4T</strong>. Slow enough to feel, not slow enough to leave.</div>
  </div>
  <div class="rounded-lg border border-border p-4" style="border-left: 3px solid var(--destructive); background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
    <div class="text-[10px] uppercase tracking-wider text-fg-muted">Frustrated · 0 points</div>
    <div class="mt-1.5 text-sm text-fg">Slower than <strong>4T</strong>, or failed at any speed.</div>
  </div>
</div>

The score is the weighted count over the total count:

<div class="my-6 rounded-lg border border-border p-5 text-center not-prose" style="background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
  <div class="font-mono text-[15px] text-fg">Apdex = (satisfied + 0.5 × tolerating) / total</div>
  <div class="mt-2 text-xs text-fg-muted">Always between 0 and 1. Both boundaries come from the single value you set for T.</div>
</div>

A worked example. In a five-minute window a service handles 10,000 requests against T = 500ms. 9,000 finish under 500ms, 800 finish between 500ms and 2s, 150 take longer than 2s, and 50 return an error.

<div class="my-6 rounded-lg border border-border p-5 not-prose" style="background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
  <div class="flex h-9 w-full overflow-hidden rounded">
    <div class="flex items-center justify-center" style="width: 90%; background: color-mix(in oklab, var(--success) 45%, transparent)">
      <span class="text-[11px] text-fg">9,000 satisfied</span>
    </div>
    <div class="flex items-center justify-center" style="width: 8%; background: color-mix(in oklab, var(--warning) 45%, transparent)">
      <span class="text-[11px] text-fg">800</span>
    </div>
    <div style="width: 2%; background: color-mix(in oklab, var(--destructive) 50%, transparent)"></div>
  </div>
  <div class="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-fg-muted">
    <span>9,000 under 500ms</span>
    <span>800 between 500ms and 2s</span>
    <span>150 over 2s</span>
    <span>50 errors</span>
  </div>
  <div class="mt-4 border-t border-border pt-4 font-mono text-sm text-fg">
    (9,000 + 0.5 × 800) / 10,000 = <span style="color: var(--primary)">0.94</span>
  </div>
</div>

Note where the 200 slow-or-failed requests went. Failures score zero no matter how quickly they came back, because a 200ms `500 Internal Server Error` did not satisfy anybody. This is what makes Apdex a rough proxy for user experience rather than a pure latency statistic.

## Choosing T, the only number that matters

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

## How to read a score

<div class="my-6 space-y-2 not-prose">
  <div class="flex items-center gap-3 rounded-lg border border-border px-4 py-3" style="background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
    <span class="w-[92px] shrink-0 font-mono text-sm" style="color: var(--success)">1.00</span>
    <span class="text-sm text-fg-muted">Every request beat T.</span>
  </div>
  <div class="flex items-center gap-3 rounded-lg border border-border px-4 py-3" style="background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
    <span class="w-[92px] shrink-0 font-mono text-sm" style="color: var(--success)">0.94 – 0.99</span>
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

## Why Apdex catches regressions a latency alert misses

A p95 alert fires on the shape of the tail. Apdex fires on the size of the tail, which is a different signal.

If a bad deploy makes 30% of requests take 3 seconds, a p95 alert at 1s fires and so does Apdex.

> **The case only Apdex catches.** A dependency starts failing 15% of requests in 40ms. The p95 gets *faster*, the latency alert stays quiet, and Apdex falls from 0.97 to about 0.83, because a fast failure is still a frustrated user.

The reverse case is real too. Apdex is a ratio, so it hides how bad the bad requests are. A service where the slow 3% take 4 seconds and one where they take 40 seconds score the same. Run an Apdex alert next to a p99 alert if you care about the worst case, not just the count.

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

## FAQ

<div class="my-6 space-y-3 not-prose">
  <div class="rounded-lg border border-border p-4" style="background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
    <div class="text-sm font-semibold text-fg">What is a good Apdex score?</div>
    <div class="mt-1.5 text-sm text-fg-muted">Above 0.94 is generally considered healthy, and 0.8 is the usual line for alerting. Both depend entirely on the T you chose, so a score is only comparable against another score measured with the same target.</div>
  </div>
  <div class="rounded-lg border border-border p-4" style="background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
    <div class="text-sm font-semibold text-fg">Apdex or p95 latency: which should I alert on?</div>
    <div class="mt-1.5 text-sm text-fg-muted">Both, for different reasons. Apdex tells you how many users had a bad time, including the ones whose requests failed. P95 and p99 tell you how bad the tail got. Apdex is the better single page-me signal; percentiles are the better debugging signal.</div>
  </div>
  <div class="rounded-lg border border-border p-4" style="background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
    <div class="text-sm font-semibold text-fg">Do failed requests count against the score?</div>
    <div class="mt-1.5 text-sm text-fg-muted">Yes. Any span with an error status counts as frustrated regardless of its duration, so a fast-failing dependency shows up as an Apdex drop even when latency looks fine.</div>
  </div>
  <div class="rounded-lg border border-border p-4" style="background: color-mix(in oklab, var(--bg-elevated) 55%, transparent)">
    <div class="text-sm font-semibold text-fg">Why is my Apdex flat at 1.0?</div>
    <div class="mt-1.5 text-sm text-fg-muted">Your T is larger than nearly every request you serve. Lower it until a healthy week reads between 0.9 and 1.0, otherwise the alert has no room to detect anything.</div>
  </div>
</div>
