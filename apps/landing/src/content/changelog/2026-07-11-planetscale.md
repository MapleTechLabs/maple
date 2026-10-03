---
title: "PlanetScale databases in Maple"
description: "Connect your PlanetScale organization once and Maple scrapes every branch, keeps a database inventory, and puts each database on the service map."
date: 2026-07-11
category: integrations
authors: [makisuo]
cover: "/changelog/2026-07-planetscale.webp"
coverAlt: "The PlanetScale integration in Maple, with branch metrics collected automatically after connecting."
---

PlanetScale is now a first-class integration. Open **Integrations → PlanetScale**, authorize your
organization, and add a service token with the `read_metrics_endpoints` permission. Maple
discovers every database branch and scrapes its metrics, and picks up new branches on its own.
You no longer configure a Prometheus scrape target by hand.

What you get once connected:

- **Infrastructure → PlanetScale**: a fleet view of your databases and branches, with a health
  drill-down for each database.
- **Service map**: database nodes your services query are matched to PlanetScale and show live
  connections, CPU, memory and replica lag. With Cloudflare connected too, a Hyperdrive node links
  to the PlanetScale database behind it.
- **Query insights**: the top queries for each database, pulled from PlanetScale.
- **Webhooks**: register Maple's endpoint in PlanetScale and OOM, storage and anomaly events open
  issues in Maple.
- A **PlanetScale Databases** dashboard template.

Get started with the [PlanetScale guide](/docs/integrations/planetscale).
