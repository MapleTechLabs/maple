# @maple-dev/effect-sdk

## 0.10.1

### Patch Changes

- ed8a412: A 5xx server span keeps its `HttpServerErrorResponse` exception on Effect 4.0.2 and later, which now fails the span itself with an `HttpServerError` for any 5xx response. Without this, those responses were grouped as one generic `HttpServerError` issue.
