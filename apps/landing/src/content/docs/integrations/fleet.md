---
title: "Fleet"
description: "Connect a Fleet server with a read-only API token. Maple puts Fleet's admin activity in the audit log, and failing device policies and vulnerable software in Security → Devices."
group: "Integrations"
order: 4.5
icon: "fleet"
---

[Fleet](https://fleetdm.com) is open-source device management built on osquery. The Maple integration reads your Fleet server with an API token and brings two things into Maple:

- **Audit log.** Fleet's activity feed: sign-ins and failed sign-ins, users and roles, policies, queries, scripts, agent settings and enroll secrets, and actions on devices such as lock and wipe. It goes to **Security → Audit log** under the Fleet platform, next to Maple's own entries and the other platforms you connected.
- **Devices.** The policies your devices fail and the vulnerable software installed on them, in **Security → Devices**, with links back into Fleet.

Maple only reads. It never runs queries, scripts or device actions, and it never changes anything in Fleet.

## Prerequisites

- You are an admin or engineer in the Maple organization. Connecting, updating the token and disconnecting need one of those roles. Any member can see whether Fleet is connected.
- A Fleet server Maple can reach over HTTPS from the internet: Fleet's managed cloud, or a self-hosted server with a public address. Maple refuses `http://` addresses and private network addresses, because the token goes with every request.
- Fleet 4 or Fleet 5, Free or Premium. Vulnerability scores (CVSS, EPSS and CISA's known exploited list) and fleets come with Fleet Premium; on Fleet Free the Devices page lists the CVEs without scores, and every policy is a global one.

## 1. Create an API-only user

Give Maple its own API-only user with the **Observer** role. Observer can read the activity feed, policies, devices and software, and nothing else Maple needs is behind a higher role.

With `fleetctl`, signed in as an admin:

```bash
fleetctl user create --name "Maple" --email maple@example.com --api-only --global-role observer
```

The command prints the user's API token once. Copy it.

In the Fleet UI instead: **Settings → Users → Add user**, choose **API-only user**, and give it the **Observer** role.

The user needs a global role. A user with roles on single fleets only cannot read the activity feed, and Maple refuses its token.

## 2. Connect

1. Open **Integrations** in Maple and pick **Fleet** under **Security & audit**.
2. Enter the address you open Fleet at in **Fleet URL**, for example `https://fleet.example.com`. A pasted API path is fine; Maple keeps the server's address.
3. Paste the token into **API token** and click **Connect**.

Maple checks the token with your server before saving it: it reads the token's user, the server version and the organization name. If Fleet rejects the token, or its user has no global role, the form says so and nothing is saved. Maple encrypts the token at rest, bound to your organization and to the server's address, so it is only ever sent to that server.

The card then shows the organization name, the URL, the server version, the license and the API user with its role. If the user has a role above Observer, the card suggests switching to an Observer user, since Maple only reads.

## Audit log

Maple reads Fleet's activity feed every 5 minutes, oldest first, from where the last read stopped. The first read goes back 7 days. A long backlog drains over the following reads, up to about 5,000 activities per read.

Each activity becomes one entry under the Fleet platform, with the Fleet user who acted, what happened, and the device, user, policy, fleet, script or query it was about.

| Category       | Examples                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------- |
| Authentication | Sign-ins, failed sign-ins (with the address tried and the client IP), MFA prompts                  |
| Membership     | Users created or deleted, users added through SSO                                                  |
| Permissions    | Global and fleet roles changed or removed                                                          |
| Credentials    | Enroll secrets edited                                                                              |
| Data access    | A device's disk encryption key read, live queries                                                  |
| Configuration  | Policies, queries, fleets, agent options and automations created, edited or deleted; specs applied |
| Resources      | Devices locked, unlocked, wiped or deleted; scripts run; software installed                        |

Activities Fleet runs on its own (automations) show Fleet as the actor. The audit log is for organization admins, as for every platform. To alert on Fleet activity, for example on any wiped device or a run of failed sign-ins, create a detection from the audit log.

## Devices

Once an hour Maple reads the server's devices, policies and vulnerable software, and replaces what the Devices page shows. A policy every device passes again, or a CVE no longer installed anywhere, drops off the page at the next read.

- **Failing policies.** Every policy at least one device fails, wherever it is set: on a fleet, on the devices in no fleet (Fleet calls these Unassigned), or globally for every device. Fleet called fleets "teams" before version 4.82; Maple reads both. Devices in no fleet have policies of their own from Fleet 4.57. Each row names the fleet the policy applies to. Critical policies come first, with how many devices fail each, its resolution, and up to 20 of the failing devices. Fleet recounts a policy's devices about once an hour, so a new policy shows here after its first count.
- **Vulnerabilities.** One row per CVE across the software versions that carry it, highest score first, with the number of devices and the affected software. Maple reads the 1,000 most installed vulnerable software versions; the page lists up to 500 CVEs.

The Devices page is for engineers and admins, as is the rest of the Security Center.

## When reading fails

- **Fleet rejects the token** (it was deleted, or the user was removed): reading stops and the card reads **Token rejected**. Paste a new token on the card to resume. The audit log continues from where it stopped, so activity from the gap still arrives as long as Fleet still holds it.
- **Fleet asks Maple to slow down:** Maple waits at least 15 minutes, or as long as Fleet asks, up to an hour.
- **The server has more than 1,000 fleets:** the Devices sync stops and the card says so, since reading only some fleets would show the rest as passing. The audit log is not affected.
- **The server is unreachable or answers with an error:** the card and the Devices page show the error, the last findings stay, and the next read tries again.

Pointing the integration at a different server makes a new connection: its audit log feed starts over from 7 days back, and the Devices page is empty until its first read, within 5 minutes. Disconnecting removes the token and the Devices findings. Audit log entries already written stay.

## Fleet's own traces

The Fleet server can send its own traces to Maple over OpenTelemetry, so you can see its API and database latency like any other service. Set these on the Fleet server:

```bash
FLEET_LOGGING_TRACING_ENABLED=true
OTEL_SERVICE_NAME=fleet
OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"   # https://ingest.eu.maple.dev for EU organizations
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
```

Fleet can also export its server logs the same way with `FLEET_LOGGING_OTEL_LOGS_ENABLED=true`. See Fleet's [server configuration](https://fleetdm.com/docs/configuration/fleet-server-configuration) for the details of each setting.

## Verify

1. After **Connect**, the Fleet card reads **Connected** with your organization name.
2. Within 5 minutes, **Security → Audit log** lists Fleet as **Receiving** under its sources, and Fleet entries appear. Sign in to Fleet to make a fresh one.
3. Within 5 minutes of connecting, **Security → Devices** shows your device count and any failing policies and vulnerable software.
