---
title: "A rebuilt API tab on service pages"
description: "See what an HTTP service rejects and why, what is slow, who calls it and how big the requests are."
date: 2026-10-24
category: services
authors: [makisuo]
---

The **API** tab on a service page now answers what operators of an HTTP service ask first.

- **A KPI strip**: requests per second, the 4xx share with its leading status code ("mostly 402"),
  the 5xx share, p95 against the previous window of the same length, and request bytes per second
  with the average body size. Each has a sparkline.
- **Responses by status**: 2xx, 4xx and 5xx stacked over the window, with deploy markers.
- **Non-2xx responses**: each status code with its count, share, most common error type and the
  routes that returned it.
- **An endpoint table** with filters for routes rejecting more than 5% of requests or slower than
  100 ms at p95.
- **An endpoint drawer**: click a route to see its status codes, latency distribution, top
  clients, request body sizes and slowest requests, each linking to its trace. The URL keeps the
  open endpoint, so you can share it.
