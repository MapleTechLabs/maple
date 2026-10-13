---
title: "Share a dashboard by link, and keep it refreshing"
description: "Share a dashboard with your org or with anyone who has the link, and set an auto-refresh interval for boards left on a wall screen."
date: 2026-08-17
category: dashboards
authors: [makisuo]
---

You can now share a dashboard with people outside Maple, and keep a board on a TV or wall monitor
up to date without anyone clicking **Reload**.

### Share links

Open the **⋮** menu in the dashboard header and choose **Share…**. Pick **Anyone in this
organization** for signed-in members of your org, or **Anyone with the link** for a public link
that needs no sign-in. Switching between the two keeps the same link. **Replace** issues a new link
and cuts off the old one, and **Not shared** turns sharing off.

A shared board looks like the one you built: same layout, groups and tabs, and the same variable
values. Add `?var-<name>=` to the URL to set a variable. Maple builds every query on its side, so a
link only ever shows the widgets on that board. Public links also unfurl in chat apps with the
board's name, description and sections.

### Auto-refresh

Pick an interval next to **Reload**: off, 5s, 10s, 30s, 1m, 5m or 15m. It works on signed-in and
shared boards, and pauses while the tab is hidden. Choosing an interval adds `?refresh=` to the
URL, so a read-only viewer can start or stop it for themselves. In edit mode it also saves as the
board's default.

Get started with [building dashboards](/docs/dashboards/build-dashboards).
