---
title: "Product events API"
description: "Post product events from a backend or mobile app to POST /v1/events on the Maple ingest gateway. The raw NDJSON contract every server-side track() call uses."
group: "Product Events"
order: 3
---

Browser page views and `track()` calls reach Maple through the session SDKs. Everything else is posted directly to the ingest gateway: a `signup_completed` from a webhook handler, a `plan_started` from your billing worker, a screen view from a native app. Rows land in the same `product_events` table as the browser events, so one funnel can span the marketing site, the app and the backend.

## Endpoint

```
POST https://ingest.maple.dev/v1/events
Authorization: Bearer YOUR_INGEST_KEY        # or X-Maple-Ingest-Key: YOUR_INGEST_KEY
Content-Type: application/x-ndjson
```

EU organizations use `https://ingest.eu.maple.dev`. The body is **NDJSON**: one JSON object per line, any number of lines. The organization is resolved from the ingest key. An `org_id` in the body is ignored.

```json
{"name":"signup_completed","user_id":"user_01H…","service_name":"maple-api"}
{"name":"plan_started","user_id":"user_01H…","group_id":"org_01H…","attributes":{"plan":"startup"}}
{"name":"$screen","source":"mobile","visitor_id":"install-8f3…","page_path":"Checkout"}
```

## Fields

| Field                                            | Type   | Notes                                                                                                                                                                                                                                               |
| ------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                           | string | **Required.** 1–128 bytes. Names starting with `$` are reserved for Maple's SDKs and dropped, except `$screen` (mobile screen view, stored as `Kind = screen`), `$identify` and `$groupidentify` (see below).                                       |
| `timestamp`                                      | string | RFC 3339 (`2026-08-17T10:15:30.123Z`) or `YYYY-MM-DD HH:MM:SS[.fff]` (UTC). Defaults to the time the gateway received the batch. Stored as UTC. Must be within the last 30 days and no more than 1 day ahead; rows outside that window are dropped. |
| `source`                                         | string | `server` (default) or `mobile`. `browser` is reserved for the SDKs; other values drop the row.                                                                                                                                                      |
| `visitor_id`                                     | string | Anonymous or device id: the browser SDK cookie value, or a persistent mobile install id. ≤ 256 bytes.                                                                                                                                               |
| `user_id`                                        | string | Your user id after sign-in, matching what you pass to `identify()`. ≤ 256 bytes.                                                                                                                                                                    |
| `group_id`                                       | string | Account / workspace / org id. ≤ 256 bytes.                                                                                                                                                                                                          |
| `session_id`                                     | string | Optional link to a browser or mobile session. ≤ 256 bytes.                                                                                                                                                                                          |
| `service_name`                                   | string | The emitting service (`maple-api`, `acme-ios`). ≤ 128 bytes.                                                                                                                                                                                        |
| `url`                                            | string | Optional. `host` (lowercase) and `page_path` (pathname only) are derived from it. ≤ 2048 bytes.                                                                                                                                                     |
| `page_path`                                      | string | Optional explicit path; overrides the one derived from `url`. Mobile `$screen` events put the screen name here. ≤ 1024 bytes.                                                                                                                       |
| `attributes`                                     | object | Optional properties. ≤ 32 keys, key ≤ 64 bytes, value ≤ 1024 bytes; non-string values are stringified.                                                                                                                                              |
| `set`, `set_once`, `group_set`, `group_set_once` | object | Optional user and account properties to write. See below.                                                                                                                                                                                           |
| `unset`, `group_unset`                           | array  | Optional names of user and account properties to remove.                                                                                                                                                                                            |

Over-long fields are truncated at the caps above, except `name`: a name over 128 bytes drops the row. Unknown fields are discarded.

## User and account properties

Any event can also write properties on its user (`user_id`) and account (`group_id`). They are kept per user and per account, a year past their last write, and charts, funnels, retention, cohorts and paths can filter and break down by them.

```json
{"name":"$identify","user_id":"user_123","visitor_id":"install-8f3…","set":{"plan":"pro","role":"admin"},"set_once":{"first_plan":"free"}}
{"name":"$groupidentify","group_id":"org_456","group_set":{"seats":12,"industry":"fintech"}}
{"name":"plan_started","user_id":"user_123","group_id":"org_456","set":{"plan":"startup"},"unset":["trial_ends"]}
```

| Field            | Applies to | Effect                                          |
| ---------------- | ---------- | ----------------------------------------------- |
| `set`            | `user_id`  | Sets each property; a later `set` replaces it.  |
| `set_once`       | `user_id`  | Sets each property only if it has no value yet. |
| `unset`          | `user_id`  | Removes each named property.                    |
| `group_set`      | `group_id` | As `set`, on the account.                       |
| `group_set_once` | `group_id` | As `set_once`, on the account.                  |
| `group_unset`    | `group_id` | As `unset`, on the account.                     |

- "Later" is the event's `timestamp`, not the order rows arrive in.
- A property is read at its current value: filtering by `plan = pro` applies a user's plan today to their earlier events too.
- Up to 64 operations per event, names ≤ 64 bytes, values ≤ 1024 bytes; non-string values are stringified and `null` values skipped. An operation without the id it applies to is ignored.
- `$identify` and `$groupidentify` are ordinary events that exist to carry these fields.
- Any event with both `visitor_id` and `user_id` links the device to the user, so a funnel counted by person joins what the device did before sign-in with what the user did after.
- `attributes` keys starting `$set.`, `$set_once.`, `$unset.` or `$group_` are reserved and dropped.

## Responses

| Status | Meaning                                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `200`  | `{"accepted": <n>}`: rows durably queued. Malformed rows (bad `name`, `source`, `timestamp`, or a `timestamp` outside the accepted window) are dropped individually and not counted. |
| `400`  | A line is not valid JSON, or not a JSON object. The whole batch is rejected.                                                                                                         |
| `401`  | Missing or invalid ingest key.                                                                                                                                                       |
| `429`  | More than 1,000 requests in flight for this organization. Retry with backoff.                                                                                                        |
| `503`  | Storage temporarily unavailable. Retry with backoff.                                                                                                                                 |

Product events are metered as their own unit, one per accepted row. Browser `track()` calls count in the same unit.

## Example

```bash
curl -X POST https://ingest.maple.dev/v1/events \
  -H "Authorization: Bearer YOUR_INGEST_KEY" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary $'{"name":"plan_started","user_id":"user_123","attributes":{"plan":"startup"}}\n'
```

## Verify

1. Send the example above. A `200` with `{"accepted": 1}` means the row was queued.
2. Within a minute, add a dashboard chart with **Product events** as its data source. The event name is available to count and filter.
3. If the response is `{"accepted": 0}`, the row was dropped. Check `name`, `source` and `timestamp` against the table above, including the 30-day window on `timestamp`.
