# @maple/browser-session

## 0.1.1

### Patch Changes

- 817980c: Session replay and session events stop sending to an endpoint that answers 404 (one without those routes, such as an older Maple Local) instead of retrying on every flush for the rest of the page.
