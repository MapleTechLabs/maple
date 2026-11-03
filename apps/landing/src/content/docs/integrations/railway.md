---
title: "Railway"
description: "Paste a Railway account or workspace token. Maple polls CPU, memory, network, and disk metrics for every service in every environment the token can see, every 5 minutes."
group: "Integrations"
order: 3.7
---

The Railway integration reads resource metrics for your Railway services with an API token. Maple polls Railway's metrics API every 5 minutes, one call per environment, and stores the results as OpenTelemetry gauges. You get CPU and memory per replica, network traffic in and out, and volume and ephemeral disk usage. The data appears under **Infrastructure → Railway** and in the [metrics explorer](/docs/explore/metrics). You do not need to install an agent or change your services.

Maple only reads metrics with the token. It never changes anything in Railway.

This page is about collecting metrics from your Railway services. To run Maple itself on Railway, see [self-hosting on Railway](/docs/self-hosting/platforms/railway). That is a different guide.

## Prerequisites

- You are an admin of the Maple organization. Connecting, **Sync now**, and disconnecting are admin actions. Any member can see the status.
- A Railway account or workspace token.

## 1. Create a token

Create the token on Railway's [account tokens page](https://railway.com/account/tokens). Use an account token or a workspace token. Project tokens only see one environment, so Maple does not ask for one.

The token is between 8 and 512 characters. Maple encrypts it at rest.

## 2. Connect

1. Open **Sources** in Maple, click **Connect source**, and pick **Railway**.
2. Paste the token into **Account or workspace token** and click **Check token**.

Maple checks the token before saving it. It lists the workspaces, projects, environments, and services the token can see, then reads a few minutes of metrics from the first environment to prove the token can read metrics. If Railway rejects the token, the form shows **Railway rejected this token. Create an account or workspace token at railway.com/account/tokens.**

Once the token works, the connect step reads **Token works.** with the workspace and environment count, and lists each project with its service count. Maple then pulls the last hour of metrics right away, so the charts start full. Environments that do not finish within about 20 seconds catch up on the next poll. The flow moves to the **Go live** step, and it is safe to leave the page while the backfill runs.

## What Maple collects

- **Every workspace the token can reach.** Maple tracks each service per environment. A project seen through two workspaces is collected once.
- **PR environments are skipped.** Each environment costs one Railway API call per poll, so Maple leaves ephemeral environments out.
- **Samples every minute.** Maple asks Railway for 1-minute samples and stays 2 minutes behind the current time, because Railway is still averaging the newest samples.
- **Every 5 minutes.** Each poll reads from where the last one stopped. After a gap, Maple catches up at most 6 hours per environment per poll.
- **Discovery every hour.** Maple refreshes the list of projects, environments, and services once an hour. A new project or environment starts reporting within the hour. Environments that disappear from Railway stop being polled.
- **Up to 15 environments per poll.** The environments furthest behind go first. The rest catch up on later polls.

If Railway rate limits the token, Maple pauses polling for at least 15 minutes, or longer when Railway asks for longer.

## Verify

1. After **Check token**, a toast reads **Railway connected** with **Pulled the last hour of metrics for** your environments.
2. The **Go live** checklist shows **Token works**, the number of environments found, **Backfilled the last hour**, and **Syncing every 5 minutes** once a poll has completed.
3. The Railway card shows a **Connected** badge, and its table lists each **Environment** with its **Services** count and **Last sync**.
4. Open **Infrastructure → Railway** to see your services.
5. In the [metrics explorer](/docs/explore/metrics), search for `railway.` to see the series.

## What you get

### Infrastructure → Railway

The page shows one row per environment and service, with **Service**, **Memory**, **vCPU**, **Replicas**, and **Last seen**. When your services do not all share the same CPU or memory limit, an **Of limit** column shows peak usage against each limit. Values are summed across replicas. A band at the top shows the summed average memory across services and a **Polling** stat with the environment count and the last sync.

Click a service for its detail page. It shows **Avg CPU**, **Avg memory**, **Peak memory**, and **Replicas**, and charts for **CPU**, **Memory**, **Network (as reported by Railway)**, and **Disk**.

### Metrics

Every series is a gauge with the instrumentation scope `maple.railway`. Memory, network, and disk values are in bytes.

| Metric                 | What it tells you                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `railway.cpu.usage`    | vCPU in use, averaged over the sample interval.                                            |
| `railway.cpu.limit`    | vCPU limit of the replica.                                                                 |
| `railway.memory.usage` | Memory in use.                                                                             |
| `railway.memory.limit` | Memory limit of the replica.                                                               |
| `railway.network.io`   | Network traffic as reported by Railway. `network.io.direction` is `receive` or `transmit`. |
| `railway.disk.usage`   | Disk in use. `railway.disk.kind` is `volume` or `ephemeral`.                               |

Each series has one resource per service and replica, with these attributes:

| Attribute                                               | Value                                  |
| ------------------------------------------------------- | -------------------------------------- |
| `service.name`, `railway.service.name`                  | The Railway service name.              |
| `railway.service.id`                                    | The Railway service id.                |
| `railway.replica.id`                                    | The replica, when Railway reports one. |
| `railway.project.id`, `railway.project.name`            | The project.                           |
| `railway.environment.id`, `railway.environment.name`    | The environment.                       |
| `deployment.environment`, `deployment.environment.name` | The environment name.                  |
| `cloud.provider`                                        | `railway`.                             |
| `cloud.region`                                          | The region, when Railway reports one.  |

`service.name` is the Railway service name. If your app names its OpenTelemetry service the same way, its metrics line up with its traces. Group dashboards and [alert rules](/docs/alerting/alert-rules) by `railway.service.id` and `railway.environment.id`, which stay stable when you rename things.

## Manage the connection

The Railway card under **Sources** has these actions:

- **View metrics** opens **Infrastructure → Railway**.
- **Sync now** polls right away instead of waiting for the next 5-minute poll. Environments that are already caught up cost no Railway call.
- **Update credential** replaces the saved token. Paste the new one and click **Update token**.

## Troubleshooting

- **The badge reads Token rejected.** Railway rejected the saved token, so polling is paused. Paste a new token to resume.
- **The badge reads Needs attention.** At least one environment failed its last poll. The environment table shows the error under the environment name.
- **This token can't see any projects yet.** The token reaches no projects. Check that it is an account or workspace token, not a project token.
- **A PR environment has no metrics.** Maple skips PR environments on purpose.
- **A new project or environment has no metrics yet.** Maple discovers them once an hour, so it starts reporting within the hour.

## Disconnect

On the Railway card, click **Disconnect** and confirm. Maple stops collecting metrics from your Railway projects and removes the saved token and its list of environments. You can reconnect later.

Disconnecting does not revoke the token in Railway. Delete the token in Railway to revoke access.

## Next steps

- [Metrics explorer](/docs/explore/metrics): chart `railway.*` series.
- [Alert rules](/docs/alerting/alert-rules): alert on memory or CPU against the replica limit.
