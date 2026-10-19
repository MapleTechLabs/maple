# @maple-dev/browser

## 0.11.1

### Patch Changes

- 737e082: A fetch that rejects because the page was hidden, unloading or offline while it was in flight is no longer marked as an error. Its span stays `Unset` and carries the reason in `maple.connection_lost`. A fetch that fails on a visible, online page is still an error.

## 0.11.0

### Minor Changes

- c060d5d: New `privacy.persistence: "memory"` mode keeps all SDK state in memory: no cookies, localStorage, sessionStorage or IndexedDB, and no visitor id. Like consent, the setting is page-global and only ever tightens.

    Opting out now deletes the SDK's cookies on every parent domain instead of probing for them, so an opt-out never writes a cookie and also clears ids written under a broader domain.
