---
title: "Pick a timezone for every chart and timestamp"
description: "Choose any IANA timezone in the time range picker, and every chart, range and timestamp on that page follows it."
date: 2026-09-10
category: platform
authors: [jeremyfunk]
---

The time range picker now has a **timezone selector** in its footer. Until now Maple always showed
times in your browser's zone, which made it hard to line up an incident with a teammate's clock
or with logs stamped in UTC.

Open the picker and choose **Timezone**. System and UTC are pinned at the top, and you can search
every other IANA zone by city, region, UTC offset (`utc+5:30`), or the current time there
(`11:20`). Your choice is saved and applies across the app.

The selected zone is used on every page with a time range picker:

- chart axes and tooltips
- the range label and the custom-range calendar
- day-aligned presets such as `today` and `7d`, which start at midnight in that zone
- hover timestamps on traces, logs, errors, alerts, services, infrastructure, metrics, releases,
  replays and agent sessions

Pages without a time range picker, such as settings and billing, keep your browser's local time.
