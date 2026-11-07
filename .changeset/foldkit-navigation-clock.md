---
"@maple-dev/effect-sdk": minor
---

Foldkit navigation spans no longer stretch to many minutes:

- Navigation and pageload timestamps now use the same clock as Effect's spans. After the computer slept, a navigation used to start up to hours before the Commands it caused, so `navigate <route>` spans lasted as long as the sleep.
- A navigation never ends more than 30 seconds after it started, even when the background tab fired the cap late or a Command ended later. Spans cut at the cap carry `maple.navigation.interrupted: true`.

New `webVitals` option on `MapleFlush.make` and `MapleFoldkit.make` (default `false`): reports LCP, CLS, INP, FCP and TTFB as `browser.web_vital` log events, loaded in a code-split chunk. In Foldkit apps they link to the `pageload` span.
