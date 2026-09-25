---
title: "Alert webhooks"
description: "The webhook destination contract: request headers, the JSON payload for each event, verifying the HMAC signature, retries, and idempotency."
group: "Reference"
order: 8
---

A webhook [notification destination](/docs/alerting/notification-destinations#webhook) sends every alert event to a URL you own. This page is the contract your endpoint can rely on.

## The request

Maple sends a `POST` with a JSON body and these headers:

| Header                 | Value                                                                    |
| ---------------------- | ------------------------------------------------------------------------ |
| `content-type`         | `application/json`                                                       |
| `x-maple-event-type`   | `trigger`, `resolve`, `renotify` or `test`                               |
| `x-maple-delivery-key` | A stable ID for this delivery. Retries reuse it; use it to deduplicate.  |
| `x-maple-signature`    | Hex HMAC-SHA256 of the raw body. Only sent when a signing secret is set. |

Respond with any `2xx` within **15 seconds**. The response body is ignored.

## Events

| Event      | Sent when                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------ |
| `trigger`  | An incident opens, after the rule's required number of consecutive breaching checks        |
| `renotify` | An incident is still breaching after the rule's re-notify interval (30 minutes by default) |
| `resolve`  | An incident closes, after the rule's required number of consecutive healthy checks         |
| `test`     | You press **Send test** on the destination, or test a rule with notifications on           |

## Payload

```json
{
	"eventType": "trigger",
	"incidentId": "b6f1…",
	"incidentStatus": "open",
	"dedupeKey": "org_…:alrt_…:checkout",
	"rule": {
		"id": "alrt_…",
		"name": "Checkout error rate",
		"signalType": "error_rate",
		"severity": "critical",
		"groupKey": "checkout",
		"comparator": "gt",
		"threshold": 5,
		"thresholdUpper": null,
		"windowMinutes": 5
	},
	"observed": { "value": 8.4, "sampleCount": 1250 },
	"template": null,
	"chart": { "url": "https://…" },
	"linkUrl": "https://app.maple.dev/alerts/…",
	"chatUrl": "https://app.maple.dev/chat?…",
	"sentAt": "2026-09-25T09:14:00.000Z",
	"event": { "specversion": "1.0", "type": "dev.maple.alert.lifecycle.trigger.v1", "…": "…" }
}
```

| Field                  | Description                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `eventType`            | Same as the `x-maple-event-type` header                                                                    |
| `incidentId`           | The incident this event belongs to. `null` for tests.                                                      |
| `incidentStatus`       | `open` or `resolved`                                                                                       |
| `dedupeKey`            | Stable for one incident across `trigger`, `renotify` and `resolve`. Use it to thread events together.      |
| `rule.signalType`      | `error_rate`, `p95_latency`, `p99_latency`, `apdex`, `throughput`, `builder_query` or `raw_query`          |
| `rule.severity`        | `warning` or `critical`                                                                                    |
| `rule.groupKey`        | The group that breached, such as a service name. `__total__` for an ungrouped rule.                        |
| `rule.comparator`      | `gt`, `gte`, `lt`, `lte`, `eq`, `neq`, `between` or `not_between`                                          |
| `rule.threshold`       | The threshold, or the lower bound for `between` and `not_between`                                          |
| `rule.thresholdUpper`  | The upper bound for `between` and `not_between`, otherwise `null`                                          |
| `rule.windowMinutes`   | The evaluation window                                                                                      |
| `observed.value`       | The value the check measured                                                                               |
| `observed.sampleCount` | How many data points the value was computed from                                                           |
| `template`             | The rule's rendered notification template, or `null`                                                       |
| `chart`                | `url` of a chart image and/or a `sparkline`, or `null`                                                     |
| `linkUrl`              | The incident in the Maple dashboard                                                                        |
| `chatUrl`              | Opens Maple's AI chat with the incident as context                                                         |
| `sentAt`               | ISO-8601 time the event was first generated. Retries keep the original value.                              |
| `event`                | The same event as a [CloudEvents 1.0](https://cloudevents.io) envelope, for routers that speak CloudEvents |

The body is identical for every destination's webhook, regardless of the rule's notification template. Treat unknown fields as additive: new fields can appear without notice.

### Error issue notifications

A destination listed in your organisation's error notification policy (set with the `update_error_notification_policy` MCP tool or the API) also receives error issue events: a new issue, a regression, a resolve, and optionally workflow changes and claims. They carry the same headers and a smaller body: `eventType`, `incidentId`, `incidentStatus`, `dedupeKey`, `rule`, `observed`, `linkUrl`, `chatUrl` and `sentAt`, without `event`, `template` or `chart`. Here `rule.id` is the issue ID, `rule.name` reads `<ExceptionType> in <service>`, and `observed.value` is the occurrence count. `dedupeKey` starts with `error:`.

Issues escalated by triage arrive with `eventType: "escalation"` in the body and an extra `escalation` object describing the issue. The `x-maple-event-type` header on these reads `trigger`, so branch on the body's `eventType`.

## Verifying the signature

Set a **signing secret** on the destination and Maple signs each body. The signature is the lowercase hex HMAC-SHA256 of the **exact bytes** of the request body, keyed with the secret, with no prefix. Compute it over the raw body before parsing the JSON, and compare in constant time.

```ts
import { createHmac, timingSafeEqual } from "node:crypto"

export function isFromMaple(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
	if (!signature) return false
	const expected = createHmac("sha256", secret).update(rawBody).digest()
	const received = Buffer.from(signature, "hex")
	return received.length === expected.length && timingSafeEqual(received, expected)
}
```

```python
import hashlib, hmac

def is_from_maple(raw_body: bytes, signature: str | None, secret: str) -> bool:
    if not signature:
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```

The signature covers the body only, and the body carries no delivery timestamp you can trust for freshness, so a captured request could be replayed. Deduplicate on `x-maple-delivery-key` to make replays harmless.

## Retries and failures

| Your response                                  | What Maple does                                 |
| ---------------------------------------------- | ----------------------------------------------- |
| `2xx`                                          | Delivered                                       |
| `408`, `429`, `5xx`, timeout, connection error | Retries with backoff                            |
| `401`, `403`                                   | Fails without retrying (authentication problem) |
| `404`, `410`                                   | Fails without retrying (endpoint gone)          |
| Any other `4xx`                                | Fails without retrying (rejected)               |

Alert events are attempted up to **5 times**, about 1, 2, 4 and 8 minutes apart, with every retry carrying the same body and `x-maple-delivery-key`. **Send test** is attempted once.

After **3 consecutive non-retryable failures**, the destination is disabled and the reason is shown on it under **Alerts → Destinations**. Fix the endpoint and re-enable it; a successful delivery resets the count.

## Endpoint checklist

- Read the raw body, verify the signature, then parse.
- Return `2xx` quickly and do slow work asynchronously; anything past 15 seconds is a failed attempt.
- Deduplicate on `x-maple-delivery-key`; retries are normal.
- Group by `dedupeKey` to follow one incident from `trigger` to `resolve`.
- Accept `test` events so **Send test** succeeds.
