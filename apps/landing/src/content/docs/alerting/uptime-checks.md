---
title: "Uptime checks"
description: "Hosted HTTP, TCP and DNS checks in Maple: create a check, the settings and their ranges, assertions, when a monitor goes down and recovers, finding a failed check's trace, setup from an AI assistant, the API, Terraform or Pulumi, and limits."
group: "Alerting"
order: 5.2
---

An uptime check is a request Maple makes to your system on a schedule: an HTTP request to a URL, a TCP connection to a port, or a DNS lookup. It runs every 30 seconds to every 15 minutes from the app, and up to every hour from the API, MCP or Terraform. When a set number of checks fail in a row, the monitor goes down and opens an [incident](/docs/alerting/incidents) through the same routing as your alert rules. The next passing check brings it back up.

Every HTTP check sends a `traceparent` header. When the service you check is instrumented, a failed check opens as the trace your service recorded for that request, so the alert shows where the time went.

For a cron job or worker that should report in, use a [heartbeat monitor](/docs/alerting/heartbeat-monitors). For an endpoint Maple cannot reach, such as one inside a private network, run [Collector HTTP checks](/docs/alerting/uptime-monitoring#check-private-endpoints-from-your-collector).

## Create a check

You need the engineer or admin role in the organization.

1. Open **Alerts → Uptime** and click **New monitor** (**New uptime check** when there are none yet).
2. Under **Type**, pick **HTTP**, **TCP** or **DNS**.
3. Enter a **Name**, such as `checkout-api`.
4. Enter the target:
    - **HTTP**: the **URL**, and the **Method** (`GET`, `HEAD` or `POST`). **Headers, body and auth** holds extra request headers, one per line, and a request body (`POST` only).
    - **TCP**: the **Host** and **Port**.
    - **DNS**: the **Hostname**, the **Record type**, and optionally an **Expected value**.
5. Set **Check every** and **Down after**: how often the check runs and how many failures in a row put the monitor down.
6. HTTP only: under **Up when**, click **Add check** to add assertions. See [Assertions](#assertions).
7. Optional: pick the **Service** the endpoint belongs to. Its failures then show on that service's page and count toward its health.
8. Under **Notify**, add [notification destinations](/docs/alerting/notification-destinations). Without one, the incident still opens in the inbox.
9. HTTP only: click **Run test** to run the check once before saving. It shows the status, the timing and the first assertion that failed.
10. Click **Create monitor**. The first check runs within about one interval.

## Settings

| Setting     | Field in the API and Terraform | Range                                                                       | Default                                                   |
| ----------- | ------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| Check every | `interval_seconds`             | 30 s to 15 min in the app; 30 to 3600 seconds in the API, MCP and Terraform | 60                                                        |
| Down after  | `failures_to_down`             | 1 to 10 failed checks in a row                                              | 2                                                         |
| Timeout     | `config.timeout_ms`            | 1000 to 30000 milliseconds                                                  | 10000                                                     |
| Method      | `config.method`                | `GET`, `HEAD`, `POST`                                                       | `GET`                                                     |
| Record type | `config.record_type`           | `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`                                     | `A` in the app and MCP; required in the API and Terraform |
| Expected    | `config.expected`              | Any text                                                                    | None: resolving is enough                                 |

A check that takes longer than the timeout fails. A DNS check with an expected value passes when any answer equals it.

## Assertions

An HTTP check passes when every assertion holds. With no status assertion, any response other than a `2xx` fails the check. When a check fails, the incident and the monitor page show the first assertion it broke.

| Assertion                  | In the API and Terraform                                                              | Failure message                                                |
| -------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Status is, or is not       | `{ type: "status", op: "is", value: "2xx" }`, `op: "is_not"`                          | `Status 503, expected 2xx`                                     |
| Response time under        | `{ type: "latency", under_ms: 800 }`                                                  | `Responded in 1240 ms, expected under 800 ms`                  |
| Body contains, or does not | `{ type: "body", op: "contains", value: "ok" }`, `"not_contains"`                     | `Body does not contain "ok"`                                   |
| JSON path exists           | `{ type: "json_path", path: "status", op: "exists" }`                                 | `JSON path status not found`                                   |
| JSON path equals           | `{ type: "json_path", path: "status", op: "equals", value: "up" }`                    | `JSON path status is degraded, expected up`                    |
| Header exists              | `{ type: "header", name: "x-request-id", op: "exists" }`                              | `Header x-request-id missing`                                  |
| Header equals, or contains | `{ type: "header", name: "content-type", op: "contains", value: "json" }`, `"equals"` | `Header content-type is "text/html", expected contains "json"` |

- Every `value` is a string, including a status code (`"204"`) and the value a JSON path must equal (`"true"`, `"42"`, `"null"`).
- A status value is a class such as `"2xx"` or an exact code such as `"204"`.
- The response time must be strictly under `under_ms`. A response slower than the timeout fails the check whatever the assertions say.
- A JSON path is a dot path with `[n]` indexes, such as `checks[0].status`. A leading `$.` is optional. There is no filter syntax, so to check an item in an array, address it by position.
- `equals` compares a JSON string as is, and any other JSON value as its JSON text: a boolean `true` in the response matches `"true"`.
- Body and JSON path assertions read the first 64 KB of the response. On a larger body, a `contains` whose text is in those 64 KB still passes. JSON path, `not_contains`, and a `contains` not found there fail with `Response body is over 64 KB, more than body checks read`.
- A `HEAD` request has no body, so body and JSON path assertions on a `HEAD` check always fail.
- Header names are matched without case.

## When a monitor goes down and recovers

A new monitor starts as **pending** until its first check.

- **Down.** The monitor goes down when **Down after** checks fail in a row. With the defaults, a check every 60 seconds and 2 failures, an outage is reported about two minutes after it starts.
- **Up.** The first passing check brings the monitor back up and resolves the incident.
- **Paused.** **Pause** on the monitor page stops the checks. **Resume** starts the monitor over from pending.

A down monitor opens an incident with the signal type `uptime` and notifies its destinations, again every 30 minutes while it stays down. The notification reads, for example, "checkout-api is down", with the check's error. Each monitor manages its own alert rule; edit the monitor, not the rule.

## Find a failed check's trace

Each check is recorded as a span from the service `maple-uptime`, in the namespace `maple-services`, with the resource attribute `maple.uptime.monitor_id`. The HTTP request carries a `traceparent` header, so an instrumented service records its own spans under the check span.

The monitor page links each failed check to its trace, and charts response time split into DNS, connect, TLS, time to first byte and transfer. To find checks in [Traces](/docs/explore/traces), filter on `service.name = maple-uptime`. To keep checks out of a service's own charts, filter out the `maple-services` namespace.

## Create a check from an AI assistant, the API or code

The same check, an HTTP monitor on a health endpoint with a JSON assertion, created four ways.

On the [MCP server](/docs/reference/mcp), `manage_uptime_monitor action=create` creates a monitor, `manage_uptime_monitor action=update` changes or pauses it, and `list_uptime_monitors` shows every monitor with its last check and trace id:

```json
{
	"kind": "http",
	"name": "checkout-api",
	"url": "https://api.example.com/health",
	"expected_status": "2xx",
	"max_response_ms": 800,
	"body_contains": "\"status\":\"up\"",
	"interval_seconds": 60,
	"failures_to_down": 2,
	"service": "checkout"
}
```

The MCP tool sets the status, the response time and one body text assertion. For JSON path and header assertions, use the app, the API or Terraform.

With the [API](/docs/reference/api), `POST /v2/uptime_monitors` creates a monitor. `kind` is required and must equal `config.type`. `config.headers` is an object of header names to values. `POST /v2/uptime_monitors/test` runs a config once without saving it:

```bash
curl https://api.maple.dev/v2/uptime_monitors \
  -H "Authorization: Bearer maple_ak_…" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "checkout-api",
    "kind": "http",
    "config": {
      "type": "http",
      "url": "https://api.example.com/health",
      "assertions": [
        { "type": "status", "op": "is", "value": "2xx" },
        { "type": "latency", "under_ms": 800 },
        { "type": "json_path", "path": "status", "op": "equals", "value": "up" }
      ]
    },
    "interval_seconds": 60,
    "failures_to_down": 2,
    "service_name": "checkout"
  }'
```

In Terraform, use [`maple_uptime_monitor`](/docs/iac/terraform-resources#maple_uptime_monitor):

```hcl
resource "maple_uptime_monitor" "checkout_api" {
  name             = "checkout-api"
  interval_seconds = 60
  failures_to_down = 2
  service_name     = "checkout"
  config = jsonencode({
    type = "http"
    url  = "https://api.example.com/health"
    assertions = [
      { type = "status", op = "is", value = "2xx" },
      { type = "latency", under_ms = 800 },
    ]
  })
  destination_ids = [maple_alert_destination.oncall.id]
}
```

In [Pulumi](/docs/iac/pulumi), the resource is `maple.UptimeMonitor`. Its arguments are camelCase (`intervalSeconds`, `failuresToDown`); the JSON `config` keeps the snake_case fields above.

## Allowlist the checks

If a firewall or bot filter blocks the checks, they fail with a `403` or a timeout. Requests from Maple carry:

- `User-Agent: maple-uptime/1.0`
- a `traceparent` header

Checks for organizations in the US region run from Ashburn, Virginia (US East). Checks for organizations in the [EU region](/docs/reference/regions) run from Frankfurt.

## Limits

- **One probe location per region.** A check runs from one place, so it cannot tell you that users in another part of the world are cut off, and a network problem near the probe looks like an outage. Raise **Down after** to ride out short blips.
- **Public targets only.** Maple refuses private, loopback and cloud metadata addresses, on the first request and on every redirect. Use [Collector HTTP checks](/docs/alerting/uptime-monitoring#check-private-endpoints-from-your-collector) for private endpoints.
- **Redirects.** A check follows up to 5 redirects. A redirect to another origin drops your configured headers and body.
- **No browser or multi-step checks**, and no hosted certificate expiry check. For certificate expiry, use the Collector's [`httpcheck.tls.cert_remaining`](/docs/alerting/uptime-monitoring#alert-before-a-certificate-expires) metric.
- **Plan allowance.** Each plan includes a number of monitors. Past it, creating one fails with `402` and "This organization already has N uptime monitors, the most its plan allows." Monitor rules do not count toward the [alert rule limit](/docs/reference/limits).

## Troubleshooting

- **Every check fails with 403.** A firewall or bot filter blocks the probe. Allow the `maple-uptime/1.0` user agent.
- **A JSON path assertion fails, but the field is there.** The response is not valid JSON, or is over 64 KB. Click **Run test** to see the error the check reports.
- **The monitor flaps between up and down.** Raise **Down after**, or raise the timeout if the endpoint is slow but healthy.
- **Failed checks have no trace from my service.** The service is not instrumented, or it does not continue the incoming `traceparent`. The check span from `maple-uptime` is still recorded.

## Next steps

- [Heartbeat monitors](/docs/alerting/heartbeat-monitors): cron jobs and workers that ping Maple.
- [Status pages](/docs/alerting/status-pages): show your monitors' status to customers.
- [Uptime monitoring](/docs/alerting/uptime-monitoring): which kind of monitoring fits which failure.
- [Incidents](/docs/alerting/incidents): what happens after a monitor goes down.
