---
title: "Railway"
description: "Deploy Maple to Railway in one click from the Maple template."
group: "Platforms"
order: 2
icon: "railway"
---

<a class="deploy-button" href="https://railway.com/deploy/maple">
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M.113 10.27A13.026 13.026 0 000 11.48h18.23c-.064-.125-.15-.237-.235-.347-3.117-4.027-4.793-3.677-7.19-3.78-.8-.034-1.34-.048-4.524-.048-1.704 0-3.555.005-5.358.01-.234.63-.459 1.24-.567 1.737h9.342v1.216H.113v.002zm18.26 2.426H.009c.02.326.05.645.094.961h16.955c.754 0 1.179-.429 1.315-.96zm-17.318 4.28s2.81 6.902 10.93 7.024c4.855 0 9.027-2.883 10.92-7.024H1.056zM11.988 0C7.5 0 3.593 2.466 1.531 6.108l4.75-.005v-.002c3.71 0 3.849.016 4.573.047l.448.016c1.563.052 3.485.22 4.996 1.364.82.621 2.007 1.99 2.712 2.965.654.902.842 1.94.396 2.934-.408.914-1.289 1.458-2.353 1.458H.391s.099.42.249.886h22.748A12.026 12.026 0 0024 12.005C24 5.377 18.621 0 11.988 0z" /></svg>
  <span>Deploy on Railway</span>
  <svg class="deploy-button__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" /></svg>
</a>

The button deploys the Maple template, so the service starts out configured:

<dl class="spec-list">
  <div><dt>Instance</dt><dd>1<span>the store is a local database</span></dd></div>
  <div><dt>Volume</dt><dd>Mounted at <code>/data</code></dd></div>
  <div><dt>Secrets</dt><dd>Generated<span>a new ingest key and access token per deploy</span></dd></div>
  <div><dt>Health check</dt><dd><code>/health</code></dd></div>
  <div><dt>TLS</dt><dd>Handled by Railway<span>no proxy to run</span></dd></div>
</dl>

## Set it up

There is nothing to fill in on the deploy page. Once the deploy finishes:

- **Secrets:** copy `MAPLE_LOCAL_INGEST_KEY` and `MAPLE_LOCAL_ACCESS_TOKEN` from the service's **Variables** tab.
- **Sign in:** open the service's `up.railway.app` URL and paste the access token.

Keep the service at one replica. A second one would not share the volume.

Next, [connect your apps](/docs/self-hosting/connect) to send telemetry.
