---
title: "Connect Google Cloud"
description: "Bring Cloud Logging, Cloud Monitoring metrics and your Google Cloud resources into Maple, set up by script, console steps or Terraform."
date: 2026-10-19
category: integrations
authors: [jeremyfunk, makisuo]
---

You can now connect a Google Cloud **organization, folder or project** to Maple. Each connection
collects what you choose:

- **Log forwarding.** Cloud Logging entries arrive in **Logs** under the service that wrote them.
- **Metrics and resources.** Metrics for Cloud Run, Cloud Functions, GKE, Compute Engine, Cloud
  SQL, Pub/Sub and HTTP(S) load balancers every 5 minutes, and the resources behind them every
  hour. They are named `gcp.*` and work in dashboards and alert rules.

**Infrastructure → Google Cloud** shows a health band across every workload (saturated, elevated,
erroring), a table per service type, and a page per workload with its charts. The workloads also
appear on the Infrastructure overview and the service map, and a dashboard template gets you a
starting point.

Pick how to set it up in the connect dialog: a Cloud Shell script, console steps with your
connection's values ready to copy, or a Terraform or Alchemy file. The IaC option also comes as a
prompt you can hand to a coding agent.

Get started with the [Google Cloud guide](/docs/integrations/gcp).
