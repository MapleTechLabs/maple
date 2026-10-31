package client

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) (*Client, *[]time.Duration) {
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	c := New(server.URL+"/", "maple_ak_test", "test")
	var slept []time.Duration
	c.sleep = func(d time.Duration) { slept = append(slept, d) }
	return c, &slept
}

func TestRetryableGetHonoursRetryAfter(t *testing.T) {
	var calls atomic.Int32
	c, slept := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"type":"rate_limit_error","message":"slow down","retryable":true,"recovery":"retry","retry_after_seconds":2}}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"dash_1"}`))
	})
	obj, err := c.Get(context.Background(), "/v2/dashboards/dash_1")
	if err != nil || obj["id"] != "dash_1" {
		t.Fatalf("got %v, %v", obj, err)
	}
	if len(*slept) != 1 || (*slept)[0] != 2*time.Second {
		t.Fatalf("expected one 2s wait, got %v", *slept)
	}
}

func TestPostIsNotRetried(t *testing.T) {
	var calls atomic.Int32
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":{"type":"api_error","message":"down","retryable":true,"recovery":"retry"}}`))
	})
	_, err := c.Post(context.Background(), "/v2/dashboards", map[string]any{"name": "x"})
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("expected a 503 APIError, got %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("POST was sent %d times", calls.Load())
	}
}

func TestErrorCarriesServerMessage(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"type":"invalid_request_error","code":"alert_rule_invalid","message":"Invalid alert rule: window_minutes must be positive","retryable":false,"recovery":"fix_request"}}`))
	})
	_, err := c.Post(context.Background(), "/v2/alerts/rules", map[string]any{})
	want := "Maple API 400 (alert_rule_invalid): Invalid alert rule: window_minutes must be positive"
	if err == nil || err.Error() != want {
		t.Fatalf("got %q, want %q", err, want)
	}
	if IsNotFound(err) {
		t.Fatal("400 reported as not found")
	}
}

func TestNotFound(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"type":"not_found_error","message":"gone","retryable":false,"recovery":"fix_request"}}`))
	})
	_, err := c.Get(context.Background(), "/v2/dashboards/dash_404")
	if !IsNotFound(err) {
		t.Fatalf("expected not found, got %v", err)
	}
}
