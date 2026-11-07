// Package kpax is a client for the KPAX API v1: OAuth2 client credentials,
// retries and rate limits, pagination, typed models and device helpers.
//
// Behaviour ids (Bxx) refer to docs/client-behavior.md in the repository.
package kpax

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DefaultScopes are the read scopes requested when Config.Scopes is empty.
var DefaultScopes = []string{
	"accounts:read", "agents:read", "devices:read", "hierarchy-elements:read",
	"dynamic-groups:read", "profiles:read", "rules:read", "labels:read", "server:read",
}

// Config configures a Client. Host, ClientID and ClientSecret are required.
type Config struct {
	Host             string // e.g. https://acme.kpax.cloud
	ClientID         string
	ClientSecret     string
	Scopes           []string      // default DefaultScopes
	Timeout          time.Duration // per attempt, default 30s
	MaxRetries       int           // default 4; use -1 for no retries
	BaseDelay        time.Duration // default 500ms
	MaxDelay         time.Duration // default 60s
	TokenRefreshSkew time.Duration // default 60s
	HTTPClient       *http.Client  // default: new client
	// Sleep and Now are for tests.
	Sleep func(ctx context.Context, d time.Duration) error
	Now   func() time.Time
}

// Client talks to one KPAX instance. It is safe for concurrent use; callers
// share one token.
type Client struct {
	host         string
	clientID     string
	clientSecret string
	scopes       []string
	timeout      time.Duration
	maxRetries   int
	baseDelay    time.Duration
	maxDelay     time.Duration
	skew         time.Duration
	http         *http.Client
	sleep        func(ctx context.Context, d time.Duration) error
	now          func() time.Time

	tokenMu      sync.Mutex
	token        string
	tokenExpires time.Time

	stateMu      sync.Mutex
	blockedUntil time.Time
	lastRate     *RateLimit
}

// New validates cfg and returns a Client (B10).
func New(cfg Config) (*Client, error) {
	host, err := normalizeHost(cfg.Host)
	if err != nil {
		return nil, err
	}
	id, secret := strings.TrimSpace(cfg.ClientID), strings.TrimSpace(cfg.ClientSecret)
	if id == "" || secret == "" {
		return nil, &ConfigError{Msg: fmt.Sprintf("connection for %s is missing ClientID or ClientSecret", host)}
	}
	c := &Client{
		host: host, clientID: id, clientSecret: secret,
		scopes:     cfg.Scopes,
		timeout:    or(cfg.Timeout, 30*time.Second),
		maxRetries: cfg.MaxRetries,
		baseDelay:  or(cfg.BaseDelay, 500*time.Millisecond),
		maxDelay:   or(cfg.MaxDelay, 60*time.Second),
		skew:       or(cfg.TokenRefreshSkew, 60*time.Second),
		http:       cfg.HTTPClient,
		sleep:      cfg.Sleep,
		now:        cfg.Now,
	}
	if len(c.scopes) == 0 {
		c.scopes = DefaultScopes
	}
	switch {
	case c.maxRetries == 0:
		c.maxRetries = 4
	case c.maxRetries < 0:
		c.maxRetries = 0
	}
	if c.http == nil {
		c.http = &http.Client{}
	}
	if c.sleep == nil {
		c.sleep = sleepCtx
	}
	if c.now == nil {
		c.now = time.Now
	}
	return c, nil
}

// Host returns the normalised instance URL.
func (c *Client) Host() string { return c.host }

// LastRateLimit returns the last X-RateLimit-* values seen, or nil (B08).
func (c *Client) LastRateLimit() *RateLimit {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	return c.lastRate
}

// ------------------------------------------------------------------ requests

// RequestOptions are the inputs of Do.
type RequestOptions struct {
	PathParams map[string]any // fills {name} placeholders, URL-encoded (B16)
	Query      map[string]any // nil values are omitted; bools become true/false
	JSON       any            // JSON body
	Form       url.Values     // form-encoded body (takes precedence over JSON)
}

// Do calls any KPAX v1 endpoint (path relative to /api/v1) with auth, retries
// and rate-limit handling, and decodes the JSON body into out (if non-nil).
func (c *Client) Do(ctx context.Context, method, path string, opts RequestOptions, out any) error {
	method = strings.ToUpper(method)
	resolved, err := interpolate(path, opts.PathParams)
	if err != nil {
		return err
	}
	status, body, err := c.send(ctx, method, resolved, opts)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return &APIError{Status: status, Method: method, Path: resolved, Body: parseBody(body)}
	}
	if out == nil || len(bytes.TrimSpace(body)) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("kpax: decoding %s %s: %w", method, resolved, err)
	}
	return nil
}

var idempotent = map[string]bool{http.MethodGet: true, http.MethodPut: true, http.MethodDelete: true}

func (c *Client) send(ctx context.Context, method, path string, opts RequestOptions) (int, []byte, error) {
	u := c.host + "/api/v1" + path
	if q := encodeQuery(opts.Query); q != "" {
		u += "?" + q
	}
	var payload []byte
	contentType := ""
	switch {
	case opts.Form != nil:
		payload = []byte(opts.Form.Encode())
		contentType = "application/x-www-form-urlencoded"
	case opts.JSON != nil:
		b, err := json.Marshal(opts.JSON)
		if err != nil {
			return 0, nil, fmt.Errorf("kpax: encoding body: %w", err)
		}
		payload = b
		contentType = "application/json"
	}

	attempt := 0
	refreshed := false
	for {
		if wait := c.blockedFor(); wait > 0 {
			if err := c.sleep(ctx, min(wait, c.maxDelay)); err != nil {
				return 0, nil, err
			}
		}
		token, err := c.getToken(ctx)
		if err != nil {
			return 0, nil, err
		}

		status, header, body, err := c.attempt(ctx, method, u, payload, contentType, token)
		if err != nil {
			if ctx.Err() != nil {
				return 0, nil, ctx.Err()
			}
			if idempotent[method] && attempt < c.maxRetries { // B07
				if serr := c.sleep(ctx, c.backoff(attempt)); serr != nil {
					return 0, nil, serr
				}
				attempt++
				continue
			}
			return 0, nil, &APIError{Status: 0, Method: method, Path: path, Body: map[string]any{"message": err.Error()}}
		}

		c.trackRateLimit(header)

		if status == http.StatusUnauthorized && !refreshed { // B04
			refreshed = true
			c.invalidateToken()
			continue
		}
		if status == http.StatusTooManyRequests && attempt < c.maxRetries { // B06
			delay, ok := c.retryAfter(header)
			if !ok {
				delay = c.backoff(attempt)
			}
			delay = min(delay, c.maxDelay)
			attempt++
			c.block(c.now().Add(delay))
			if err := c.sleep(ctx, delay); err != nil {
				return 0, nil, err
			}
			continue
		}
		if status >= 500 && idempotent[method] && attempt < c.maxRetries { // B07
			if err := c.sleep(ctx, c.backoff(attempt)); err != nil {
				return 0, nil, err
			}
			attempt++
			continue
		}
		return status, body, nil
	}
}

func (c *Client) attempt(ctx context.Context, method, u string, payload []byte, contentType, token string) (int, http.Header, []byte, error) {
	actx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	var rdr io.Reader
	if payload != nil {
		rdr = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(actx, method, u, rdr)
	if err != nil {
		return 0, nil, nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return 0, nil, nil, err
	}
	return res.StatusCode, res.Header, body, nil
}

// --------------------------------------------------------------------- token

func (c *Client) getToken(ctx context.Context) (string, error) {
	c.tokenMu.Lock() // B03: one fetch for concurrent callers
	defer c.tokenMu.Unlock()
	if c.token != "" && c.now().Before(c.tokenExpires) {
		return c.token, nil
	}
	form := url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {c.clientID},
		"client_secret": {c.clientSecret},
		"scope":         {strings.Join(c.scopes, " ")},
	}
	actx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(actx, http.MethodPost, c.host+"/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", &AuthError{Status: 0, Host: c.host, Body: map[string]any{"message": err.Error()}}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 { // B05
		return "", &AuthError{Status: res.StatusCode, Host: c.host, Body: parseBody(raw)}
	}
	var tok struct {
		AccessToken string   `json:"access_token"`
		ExpiresIn   *float64 `json:"expires_in"`
	}
	if err := json.Unmarshal(raw, &tok); err != nil || tok.AccessToken == "" {
		return "", &AuthError{Status: res.StatusCode, Host: c.host, Body: map[string]any{"message": "token response did not include access_token"}}
	}
	ttl := 3600.0
	if tok.ExpiresIn != nil && *tok.ExpiresIn > 0 {
		ttl = *tok.ExpiresIn
	}
	life := time.Duration(ttl*float64(time.Second)) - c.skew
	if life < 0 {
		life = 0
	}
	c.token = tok.AccessToken
	c.tokenExpires = c.now().Add(life)
	return c.token, nil
}

func (c *Client) invalidateToken() {
	c.tokenMu.Lock()
	c.token = ""
	c.tokenExpires = time.Time{}
	c.tokenMu.Unlock()
}

// -------------------------------------------------------------- rate limits

func (c *Client) blockedFor() time.Duration {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	return c.blockedUntil.Sub(c.now())
}

func (c *Client) block(until time.Time) {
	c.stateMu.Lock()
	if until.After(c.blockedUntil) {
		c.blockedUntil = until
	}
	c.stateMu.Unlock()
}

func (c *Client) trackRateLimit(h http.Header) {
	limit, remaining, reset := intHeader(h, "X-RateLimit-Limit"), intHeader(h, "X-RateLimit-Remaining"), intHeader(h, "X-RateLimit-Reset")
	if limit == nil && remaining == nil && reset == nil {
		return
	}
	c.stateMu.Lock()
	c.lastRate = &RateLimit{Limit: limit, Remaining: remaining, Reset: reset}
	c.stateMu.Unlock()
	if remaining != nil && *remaining == 0 && reset != nil && *reset > 0 { // B08
		c.block(time.Unix(*reset, 0))
	}
}

func (c *Client) retryAfter(h http.Header) (time.Duration, bool) {
	if ra := strings.TrimSpace(h.Get("Retry-After")); ra != "" {
		if secs, err := strconv.ParseFloat(ra, 64); err == nil {
			return time.Duration(math.Max(secs, 0) * float64(time.Second)), true
		}
		if t, err := http.ParseTime(ra); err == nil {
			return max(t.Sub(c.now()), 0), true
		}
	}
	if reset := intHeader(h, "X-RateLimit-Reset"); reset != nil {
		return max(time.Unix(*reset, 0).Sub(c.now()), 0), true
	}
	return 0, false
}

func (c *Client) backoff(attempt int) time.Duration {
	exp := float64(c.baseDelay) * math.Pow(2, float64(attempt))
	d := time.Duration(exp/2 + rand.Float64()*(exp/2))
	return min(d, c.maxDelay)
}

// ------------------------------------------------------------------ helpers

func normalizeHost(host string) (string, error) {
	h := strings.TrimRight(strings.TrimSpace(host), "/")
	if strings.HasSuffix(strings.ToLower(h), "/api/v1") {
		h = strings.TrimRight(h[:len(h)-len("/api/v1")], "/")
	}
	u, err := url.Parse(h)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", &ConfigError{Msg: fmt.Sprintf("host is not a valid http(s) URL: %q", h)}
	}
	return h, nil
}

func interpolate(path string, params map[string]any) (string, error) {
	var b strings.Builder
	for {
		i := strings.IndexByte(path, '{')
		if i < 0 {
			b.WriteString(path)
			return b.String(), nil
		}
		j := strings.IndexByte(path[i:], '}')
		if j < 0 {
			return "", fmt.Errorf("kpax: unterminated placeholder in %q", path)
		}
		name := path[i+1 : i+j]
		v, ok := params[name]
		s := fmt.Sprint(v)
		if !ok || v == nil || s == "" {
			return "", fmt.Errorf("kpax: missing path parameter %q", name)
		}
		b.WriteString(path[:i])
		b.WriteString(url.PathEscape(s))
		path = path[i+j+1:]
	}
}

// encodeQuery drops nil values, renders bools as true/false (B16).
func encodeQuery(q map[string]any) string {
	if len(q) == 0 {
		return ""
	}
	v := url.Values{}
	for k, val := range q {
		switch x := val.(type) {
		case nil:
			continue
		case *int:
			if x != nil {
				v.Set(k, strconv.Itoa(*x))
			}
		case *bool:
			if x != nil {
				v.Set(k, strconv.FormatBool(*x))
			}
		case *string:
			if x != nil {
				v.Set(k, *x)
			}
		case bool:
			v.Set(k, strconv.FormatBool(x))
		case string:
			v.Set(k, x)
		default:
			v.Set(k, fmt.Sprint(x))
		}
	}
	return v.Encode()
}

func parseBody(b []byte) any {
	b = bytes.TrimSpace(b)
	if len(b) == 0 {
		return nil
	}
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return string(b)
	}
	return v
}

func intHeader(h http.Header, name string) *int64 {
	s := strings.TrimSpace(h.Get(name))
	if s == "" {
		return nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	n := int64(f)
	return &n
}

func or(d, def time.Duration) time.Duration {
	if d > 0 {
		return d
	}
	return def
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
