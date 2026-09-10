---
title: "Apdex alerts"
description: "What the Apdex score measures, how to pick the target latency T that defines it, and how to set up an Apdex alert in Maple so you get paged when the share of fast requests drops."
group: "Alerting"
order: 1
---

A p95 latency alert tells you that 5% of requests were slower than some number. It does not tell you whether that was 5 requests or 50,000, and it says nothing about the requests that failed outright. Apdex answers a different question: of everything that hit this service in the last five minutes, what share of it was fast enough to keep a user happy?

This page covers what the score actually is, how to choose the one input that decides everything about it, and how to turn it into an alert rule in Maple.

## What is the Apdex score?

Apdex (Application Performance Index) is an industry-standard measure of user satisfaction derived from response times. It compresses a latency distribution into a single number between 0 and 1, where 1 means every request was fast and 0 means none of them were.

You pick one input, a target response time called **T**. Every request in the window then lands in one of three buckets:

| Bucket | Condition | Weight |
| --- | --- | --- |
| Satisfied | faster than **T** | 1 |
| Tolerating | between **T** and **4T** | 0.5 |
| Frustrated | slower than **4T**, or the request failed | 0 |

The score is the weighted count over the total count:

```
Apdex = (satisfied + 0.5 × tolerating) / total
```

A worked example. In a five-minute window a service handles 10,000 requests against T = 500ms. 9,000 finish under 500ms, 800 finish between 500ms and 2s, 150 take longer than 2s, and 50 return an error. The satisfied and tolerating counts carry the score:

```
(9000 + 0.5 × 800) / 10000 = 0.94
```

Note where the 200 slow-or-failed requests went. Failures score zero no matter how quickly they came back, because a 200ms `500 Internal Server Error` did not satisfy anybody. This is what makes Apdex a rough proxy for user experience rather than a pure latency statistic.

## Choosing T, the only number that matters

T is the whole rule. It sets the satisfied boundary directly and the frustrated boundary implicitly, since the tolerating band always ends at 4T. Move T from 500ms to 1s and you have also moved the frustrated line from 2s to 4s.

Pick T as the latency at which your users stop perceiving the response as immediate, per class of traffic:

- **Internal or service-to-service APIs:** 200ms to 300ms. These sit inside someone else's request, so their budget is small.
- **User-facing API endpoints:** 500ms. This is Maple's default and a reasonable starting point for a JSON API behind a UI.
- **Full page loads or heavy reports:** 1s to 2s. Users accept more from something that visibly does more work.
- **Background or batch endpoints:** Apdex is usually the wrong tool. Nobody is waiting, so alert on throughput or failure rate instead.

Two things to avoid. Do not set T to your current p95 and call it done, because that guarantees a score around 0.95 forever and tells you nothing new. And do not set T so tight that your steady state already sits at 0.6, because then every alert threshold you pick sits inside your normal noise.

The honest way to choose is to open the service's Apdex chart in Maple, set T, and check that a healthy week reads somewhere in the 0.9 to 1.0 band. That leaves the 0.8 line meaningful.

## How to read a score

| Score | What it means |
| --- | --- |
| 1.00 | Every request beat T |
| 0.94 to 0.99 | Healthy, with a normal slow tail |
| 0.85 to 0.94 | Degraded, and users can feel it |
| Below 0.80 | The common alerting line. Roughly a fifth of traffic is frustrated or worse |
| Below 0.50 | Most requests are failing or timing out |

0.8 is a convention, not a law. The number that matters is where your service sits when it is healthy, and how far it has to fall before you would want to be woken up.

## Why Apdex catches regressions a latency alert misses

A p95 alert fires on the shape of the tail. Apdex fires on the size of the tail, which is a different signal.

If a bad deploy makes 30% of requests take 3 seconds, a p95 alert at 1s fires and so does Apdex. If a dependency starts failing 15% of requests in 40ms, the p95 gets *faster*, the latency alert stays quiet, and Apdex drops from 0.97 to about 0.83 because errors count as frustrated.

The reverse case is real too. Apdex is a ratio, so it hides how bad the bad requests are. A service where the slow 3% take 4 seconds and one where they take 40 seconds score the same. Run an Apdex alert next to a p99 alert if you care about the worst case, not just the count.

## Setting up an Apdex alert in Maple

Maple computes Apdex over the entry-point spans of a service, which is to say the server and consumer spans and the trace roots, not every internal span. That is the same set of requests the service's Apdex chart draws, so a rule you build here matches what you saw on the chart that sent you looking.

1. Open **Alerts → New rule**. Starting from a service page instead (**Services → your service → Create Alert**) pre-fills the scope.
2. On the **Start with a template** screen, pick **Low Apdex score**. It fills in the whole rule: signal Apdex, target 500ms, fires below 0.8, five-minute window. Or choose the **Apdex** signal chip and set the fields yourself.
3. Set **Apdex target (ms)** to your T. Requests under this duration count as fully satisfied, and the frustrated line follows at 4T.
4. Set the **Condition** to `<` and the threshold to the score you want to defend, for example `0.8`.
5. Choose an evaluation **window**. Five minutes is the default and works for most services. Anything from one minute up to 24 hours is allowed, but short windows on low-traffic services are noisy, because a handful of slow requests moves the ratio a long way.
6. Scope the rule under **Services** and **Environments**. Leave services empty to watch everything, or add a **Group by** of `service.name` or `attr.http.route` to evaluate each group separately and get one incident per offender rather than one blended average.
7. Pick a **Severity**, attach your [notification destinations](/docs/alerting/notification-destinations), and save.

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

## Known limitations

- **Apdex is computed on sampled spans.** If you sample at 10%, the score is the ratio measured across the requests you kept. That stays representative under uniform sampling, but a sampling policy that keeps slow or failed traces preferentially will drag the score down relative to reality.
- **One T per rule.** A service whose `/healthz` and `/reports/export` share a rule is being measured against a target that fits neither. Group by `attr.http.route`, or write separate rules.
- **The score hides magnitude.** It counts frustrated requests without weighting how frustrated they were. Pair it with a p99 rule.

## FAQ

**What is a good Apdex score?**
Above 0.94 is generally considered healthy, and 0.8 is the usual line for alerting. Both depend entirely on the T you chose, so a score is only comparable against another score measured with the same target.

**Apdex or p95 latency: which should I alert on?**
Both, for different reasons. Apdex tells you how many users had a bad time, including the ones whose requests failed. P95 and p99 tell you how bad the tail got. Apdex is the better single page-me signal; percentiles are the better debugging signal.

**Do failed requests count against the score?**
Yes. Any span with an error status counts as frustrated regardless of its duration, so a fast-failing dependency shows up as an Apdex drop even when latency looks fine.

**Why is my Apdex flat at 1.0?**
Your T is larger than nearly every request you serve. Lower it until a healthy week reads between 0.9 and 1.0, otherwise the alert has no room to detect anything.
