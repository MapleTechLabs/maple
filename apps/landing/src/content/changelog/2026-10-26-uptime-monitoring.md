---
title: "Uptime monitoring"
description: "Hosted HTTP, TCP, DNS and heartbeat checks that open incidents through your alert routing and link each failed check to its trace."
date: 2026-10-26
category: alerts
authors: [makisuo]
---

Maple now runs **uptime checks** for you. Add a monitor from **Alerts → Uptime**, or pick
**Uptime check** from **New rule**:

- **HTTP**: status code, response time, body text, JSON path and header assertions.
- **TCP**: the port accepts a connection.
- **DNS**: the name resolves, optionally to the record you expect.
- **Heartbeat**: your cron job or worker pings a URL on an interval or a cron schedule, and Maple
  alerts when a ping is late or reports a failure.

Checks run every 30 seconds to every hour. A monitor goes down after 1 to 10 failed checks in a
row (2 by default) and comes back up on the first success. A down monitor opens an incident
through the same routing as your alert rules, and the notification reads "checkout-api is down"
with the check's error.

Each HTTP check sends a `traceparent` header, so a failed check links to the trace your service
recorded for it. The monitor page charts response time split into DNS, connect, TLS, time to
first byte and transfer, so you can see which phase got slow. Link a monitor to a service and it
shows on the service page, and counts toward that service's health.

Read more on the [uptime monitoring page](/features/uptime-monitoring).
