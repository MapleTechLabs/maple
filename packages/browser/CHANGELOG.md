# @maple-dev/browser

## 0.11.0

### Minor Changes

- c060d5d: New `privacy.persistence: "memory"` mode keeps all SDK state in memory: no cookies, localStorage, sessionStorage or IndexedDB, and no visitor id. Like consent, the setting is page-global and only ever tightens.

    Opting out now deletes the SDK's cookies on every parent domain instead of probing for them, so an opt-out never writes a cookie and also clears ids written under a broader domain.
