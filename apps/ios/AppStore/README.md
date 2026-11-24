# App Store submission

What App Store Connect holds for app 6762027292 ("Maple Companion"). Everything
here, screenshots and App Privacy (`privacy.json`, via `asc web privacy apply`) included, was applied with the `asc` CLI on
2026-11-24; `asc validate --app 6762027292 --version-id 62ad196b-9279-4bec-815d-59528e0259e9`
shows what is left. Keep `app-privacy.md` in step with `Maple/Resources/PrivacyInfo.xcprivacy`.

## App information

| Field             | Value                                                |
| ----------------- | ---------------------------------------------------- |
| Name (30)         | Maple Companion                                      |
| Subtitle (30)     | Alerts, traces and errors                            |
| Bundle ID         | com.maple.mobile                                     |
| Primary category  | Developer Tools                                      |
| Secondary         | Business                                             |
| Content rights    | Does not contain, show or access third-party content |
| Age rating        | 4+ (every question "None" / "No", see below)         |
| Privacy policy    | https://maple.dev/privacy                            |
| Support URL       | https://maple.dev/contact                            |
| Marketing URL     | https://maple.dev                                    |
| Copyright         | 2026 Makisuo, Inc.                                   |
| Price             | Free, no in-app purchases                            |
| Availability      | All territories                                      |
| Devices           | iPhone only (iPad not supported)                     |

## Version 1.0.0

Release type: manual (approval does not publish it).

**Promotional text (170)**

> Know when production breaks and why, from your phone. Critical alerts on your Lock Screen, service health at a glance, and the trace behind every error.

**Description (4000)**

> Maple is the mobile companion to the Maple observability platform. It answers three questions without opening a laptop: is anything wrong right now, why is it going off, and tell me when it happens.
>
> OVERVIEW
> One screen for the state of production: open alerts with the last hour of their signal, services that need attention, and what is new in the last 24 hours.
>
> SERVICES
> Every service with throughput, error rate and p95 latency, sorted worst first. Each service opens to a health verdict with the reason behind it, scrubbable charts for each golden signal, its busiest operations, alerts and errors.
>
> TRIAGE
> Incidents, error issues and anomalies in one place. An incident shows what the rule saw, what changed on the service, and a timeline.
>
> EXPLORE
> Search traces and logs, open any trace as a waterfall, and read your dashboards.
>
> ALERTS THAT REACH YOU
> Push notifications for critical incidents, with Time Sensitive delivery through Focus. A critical incident stays on your Lock Screen as a Live Activity until it resolves.
>
> WIDGETS
> Ongoing issues and throughput for your organization or a single service, on the Home Screen and Lock Screen.
>
> Maple is built on OpenTelemetry. You need a Maple account and an organization sending telemetry; sign up free at maple.dev.

**Keywords (100)**

```
observability,opentelemetry,monitoring,apm,logs,metrics,incident,devops,sre,uptime,latency,oncall
```

**What's new**

> First release of Maple for iPhone.

## Screenshots

`screenshots/*.jpg`, uploaded as the 6.9" iPhone set (1320 x 2868, JPEG: App
Store Connect refuses PNGs with alpha). Taken in fixture mode on an iPhone 17
Pro Max simulator with the status bar pinned to 9:41, via `maple://debug/...`
deep links: overview, service, incident, issue, trace, triage, logs. Retake and
replace with
`asc screenshots upload --app 6762027292 --version-id <id> --locale en-US --device-type IPHONE_69 --path screenshots --replace --confirm`.

## Age rating questionnaire

All content descriptors: None. Unrestricted web access: No (links open in
Safari). User-generated content: No. Messaging or chat: No. Gambling,
contests, loot boxes: No. Medical or wellness: No. Parental controls / age
assurance: No. Result: 4+.

## Export compliance

`ITSAppUsesNonExemptEncryption` is `false` in the Info.plist: the app only uses
HTTPS (URLSession) and Apple's own Secure Enclave signing, which are exempt. No
documentation upload is needed.

## Sign-in for App Review

See `review-notes.md`.
