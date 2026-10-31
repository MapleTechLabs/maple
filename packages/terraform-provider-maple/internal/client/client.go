// Package client is a thin JSON client for the Maple public v2 API.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const DefaultBaseURL = "https://api.maple.dev"

// APIError is a non-2xx response carrying the v2 error envelope.
type APIError struct {
	Status            int
	Type              string
	Code              string
	Message           string
	Retryable         bool
	RetryAfterSeconds *float64
}

func (e *APIError) Error() string {
	msg := e.Message
	if msg == "" {
		msg = http.StatusText(e.Status)
	}
	if e.Code != "" {
		return fmt.Sprintf("Maple API %d (%s): %s", e.Status, e.Code, msg)
	}
	return fmt.Sprintf("Maple API %d: %s", e.Status, msg)
}

// IsNotFound reports whether err is a 404 from the Maple API.
func IsNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound
}

type Client struct {
	baseURL    string
	apiKey     string
	userAgent  string
	httpClient *http.Client
	// sleep is swapped out in tests so retries don't wait.
	sleep func(time.Duration)
}

func New(baseURL, apiKey, userAgent string) *Client {
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		apiKey:     apiKey,
		userAgent:  userAgent,
		httpClient: &http.Client{Timeout: 60 * time.Second},
		sleep:      time.Sleep,
	}
}

// Object is a decoded JSON object. Numbers decode as json.Number.
type Object = map[string]any

func (c *Client) Get(ctx context.Context, path string) (Object, error) {
	return c.do(ctx, http.MethodGet, path, nil)
}

func (c *Client) Post(ctx context.Context, path string, body any) (Object, error) {
	return c.do(ctx, http.MethodPost, path, body)
}

func (c *Client) Patch(ctx context.Context, path string, body any) (Object, error) {
	return c.do(ctx, http.MethodPatch, path, body)
}

func (c *Client) Delete(ctx context.Context, path string) error {
	_, err := c.do(ctx, http.MethodDelete, path, nil)
	return err
}

const maxAttempts = 6

func (c *Client) do(ctx context.Context, method, path string, body any) (Object, error) {
	var payload []byte
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encoding request body: %w", err)
		}
		payload = encoded
	}
	// Only idempotent methods retry on their own; a retried POST could create twice.
	idempotent := method == http.MethodGet || method == http.MethodDelete
	for attempt := 0; ; attempt++ {
		result, err := c.attempt(ctx, method, path, payload)
		var apiErr *APIError
		if err == nil || !idempotent || attempt+1 >= maxAttempts || !errors.As(err, &apiErr) || !apiErr.Retryable {
			return result, err
		}
		delay := time.Duration(min(500*(1<<attempt), 10_000)) * time.Millisecond
		if apiErr.RetryAfterSeconds != nil {
			delay = time.Duration(*apiErr.RetryAfterSeconds * float64(time.Second))
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
			c.sleep(delay)
		}
	}
}

func (c *Client) attempt(ctx context.Context, method, path string, payload []byte) (Object, error) {
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.userAgent)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, fmt.Errorf("%s %s: reading response: %w", method, path, err)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, decodeError(res.StatusCode, raw)
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, nil
	}
	return Decode(raw)
}

// Decode parses a JSON object, keeping numbers exact.
func Decode(raw []byte) (Object, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var out Object
	if err := decoder.Decode(&out); err != nil {
		return nil, fmt.Errorf("Maple API returned invalid JSON: %w", err)
	}
	return out, nil
}

func decodeError(status int, raw []byte) error {
	var envelope struct {
		Error struct {
			Type              string   `json:"type"`
			Code              string   `json:"code"`
			Message           string   `json:"message"`
			Retryable         bool     `json:"retryable"`
			RetryAfterSeconds *float64 `json:"retry_after_seconds"`
		} `json:"error"`
	}
	apiErr := &APIError{Status: status}
	if json.Unmarshal(raw, &envelope) == nil && envelope.Error.Type != "" {
		apiErr.Type = envelope.Error.Type
		apiErr.Code = envelope.Error.Code
		apiErr.Message = envelope.Error.Message
		apiErr.Retryable = envelope.Error.Retryable
		apiErr.RetryAfterSeconds = envelope.Error.RetryAfterSeconds
		return apiErr
	}
	// A gateway in front of the API can answer without the envelope.
	apiErr.Retryable = status == http.StatusTooManyRequests || status == http.StatusBadGateway ||
		status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout
	return apiErr
}
