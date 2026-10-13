---
title: "Fewer freezes, faster loads, and errors that recover"
description: "Data-heavy pages no longer freeze or crash the tab, traces and dashboards load faster, and connection errors retry on their own."
date: 2026-07-31
category: platform
authors: [makisuo]
---

This release focused on making Maple feel steady on large orgs and long sessions.

- **No more freezes.** Fixed the main-thread freezes and tab crashes on data-heavy pages, and added
  checks so regressions get caught before they ship. The app also loads much less JavaScript up
  front.
- **Smoother rendering.** Removed rerenders that rippled across the whole app, and moved loading
  skeletons and page transitions off the main thread.
- **Faster loads.** Traces and dashboards load faster, and searches over wide time ranges are
  quicker.
- **Errors that recover.** A transient "Cannot reach Maple API" error now retries on its own, and
  retries right away when your connection or tab comes back.
- **Clearer failures.** Data that fails to load shows an error state with a retry button instead of
  an empty panel, and a crash shows a proper error screen.
- **Deep links.** Hard-refreshing a deep link no longer sends you back to the home page.
- **Other fixes:** duplicate alert notification emails, session replays that wouldn't play, and the
  time jumping when you picked a custom range.
