---
"@maple-dev/browser": minor
"@maple-dev/effect-sdk": minor
---

New `privacy.persistence: "cookieless"` mode. Like `"memory"`, the SDK stores nothing on the device (no cookies, Web Storage or IndexedDB). Unlike `"memory"`, unique visitors are still counted: the ingest gateway derives a visitor id that changes every UTC day, from a salt it deletes after two days. Unique visitors are counted within a day, not across days, and new vs returning is unavailable. Consent under `requireConsent`, Global Privacy Control, `respectDoNotTrack` with Do Not Track, and `persistVisitorId: false` still turn the visitor id off. If two SDKs on a page set different modes, `"memory"` wins.
