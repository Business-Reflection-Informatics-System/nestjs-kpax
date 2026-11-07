package kpax

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// --------------------------------------------------------------- mock KPAX

type mockKpax struct {
	t         *testing.T
	srv       *httptest.Server
	mu        sync.Mutex
	calls     []*http.Request
	bodies    []string
	tokens    []url.Values
	seq       int64
	handler   func(r *http.Request, n int) (int, any, map[string]string)
	tokenH    func() (int, any)
	tokenGate chan struct{}
}

func newMock(t *testing.T) *mockKpax {
	m := &mockKpax{t: t}
	m.handler = func(*http.Request, int) (int, any, map[string]string) {
		return 200, fixture(t, "server-status.json"), nil
	}
	m.srv = httptest.NewServer(http.HandlerFunc(m.serve))
	t.Cleanup(m.srv.Close)
	return m
}

func (m *mockKpax) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	if r.URL.Path == "/oauth/token" {
		if m.tokenGate != nil {
			<-m.tokenGate
		}
		form, _ := url.ParseQuery(string(body))
		m.mu.Lock()
		m.tokens = append(m.tokens, form)
		m.mu.Unlock()
		if m.tokenH != nil {
			status, b := m.tokenH()
			writeJSON(w, status, b, nil)
			return
		}
		n := atomic.AddInt64(&m.seq, 1)
		writeJSON(w, 200, map[string]any{"token_type": "Bearer", "expires_in": 3600, "access_token": fmt.Sprintf("tok-%d", n)}, nil)
		return
	}
	m.mu.Lock()
	m.calls = append(m.calls, r.Clone(context.Background()))
	m.bodies = append(m.bodies, string(body))
	n := len(m.calls)
	m.mu.Unlock()
	status, b, h := m.handler(r, n)
	writeJSON(w, status, b, h)
}

func writeJSON(w http.ResponseWriter, status int, body any, headers map[string]string) {
	for k, v := range headers {
		w.Header().Set(k, v)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func fixture(t *testing.T, name string) any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	sleeps []time.Duration
}

func (f *fakeClock) Now() time.Time { f.mu.Lock(); defer f.mu.Unlock(); return f.now }
func (f *fakeClock) Sleep(_ context.Context, d time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sleeps = append(f.sleeps, d)
	f.now = f.now.Add(d)
	return nil
}

func newClient(t *testing.T, m *mockKpax) (*Client, *fakeClock) {
	t.Helper()
	clk := &fakeClock{now: time.Unix(1_800_000_000, 0)}
	c, err := New(Config{
		Host: m.srv.URL + "/", ClientID: "cid", ClientSecret: "secret-1",
		BaseDelay: time.Millisecond, Sleep: clk.Sleep, Now: clk.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	return c, clk
}

func eq[T comparable](t *testing.T, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("got %v, want %v", got, want)
	}
}

var ctx = context.Background()

// ------------------------------------------------------------------- tests

func TestB01B02ClientCredentialsAndBearer(t *testing.T) {
	m := newMock(t)
	c, _ := newClient(t, m)
	s, err := c.ServerStatus(ctx)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, s.Version, "3.20.0")
	f := m.tokens[0]
	eq(t, f.Get("grant_type"), "client_credentials")
	eq(t, f.Get("client_id"), "cid")
	eq(t, f.Get("client_secret"), "secret-1")
	eq(t, f.Get("scope"), strings.Join(DefaultScopes, " "))
	eq(t, m.calls[0].URL.Path, "/api/v1/server/status")
	eq(t, m.calls[0].Header.Get("Authorization"), "Bearer tok-1")
	eq(t, m.calls[0].Header.Get("Accept"), "application/json")
}

func TestB03TokenCachedAndRefreshed(t *testing.T) {
	m := newMock(t)
	c, clk := newClient(t, m)
	_, _ = c.ServerStatus(ctx)
	_, _ = c.ServerStatus(ctx)
	eq(t, len(m.tokens), 1)
	clk.now = clk.now.Add(3600*time.Second - 60*time.Second + time.Second)
	_, _ = c.ServerStatus(ctx)
	eq(t, len(m.tokens), 2)
}

func TestB03ConcurrentCallersShareToken(t *testing.T) {
	m := newMock(t)
	m.tokenGate = make(chan struct{})
	c, _ := newClient(t, m)
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = c.ServerStatus(ctx) }()
	}
	time.Sleep(50 * time.Millisecond)
	close(m.tokenGate)
	wg.Wait()
	eq(t, len(m.tokens), 1)
	eq(t, len(m.calls), 5)
}

func TestB04RefreshOnceOn401(t *testing.T) {
	m := newMock(t)
	c, _ := newClient(t, m)
	m.handler = func(_ *http.Request, n int) (int, any, map[string]string) {
		if n == 1 {
			return 401, map[string]any{"message": "Unauthenticated."}, nil
		}
		return 200, fixture(t, "server-status.json"), nil
	}
	if _, err := c.ServerStatus(ctx); err != nil {
		t.Fatal(err)
	}
	eq(t, m.calls[0].Header.Get("Authorization"), "Bearer tok-1")
	eq(t, m.calls[1].Header.Get("Authorization"), "Bearer tok-2")

	m.handler = func(*http.Request, int) (int, any, map[string]string) {
		return 401, map[string]any{"message": "Invalid scope(s) provided."}, nil
	}
	_, err := c.ServerStatus(ctx)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 401 || !strings.Contains(err.Error(), "Invalid scope") {
		t.Fatalf("want 401 APIError, got %v", err)
	}
}

func TestB05TokenRefused(t *testing.T) {
	m := newMock(t)
	m.tokenH = func() (int, any) { return 401, map[string]any{"error": "invalid_client"} }
	c, _ := newClient(t, m)
	_, err := c.ServerStatus(ctx)
	var authErr *AuthError
	if !errors.As(err, &authErr) || authErr.Status != 401 || !strings.Contains(err.Error(), "invalid_client") {
		t.Fatalf("want AuthError 401, got %v", err)
	}
}

func TestB06RetryAfterOn429ForAnyMethod(t *testing.T) {
	m := newMock(t)
	c, clk := newClient(t, m)
	m.handler = func(_ *http.Request, n int) (int, any, map[string]string) {
		if n == 1 {
			return 429, map[string]any{}, map[string]string{"Retry-After": "7"}
		}
		return 200, map[string]any{"data": []any{}}, nil
	}
	if _, err := c.SearchDevices(ctx, DeviceSearchOptions{}); err != nil {
		t.Fatal(err)
	}
	eq(t, len(m.calls), 2)
	eq(t, clk.sleeps[0], 7*time.Second)
}

func TestB07RetryGetNotPost(t *testing.T) {
	m := newMock(t)
	c, _ := newClient(t, m)
	m.handler = func(_ *http.Request, n int) (int, any, map[string]string) {
		if n < 3 {
			return 503, map[string]any{}, nil
		}
		return 200, fixture(t, "server-status.json"), nil
	}
	if _, err := c.ServerStatus(ctx); err != nil {
		t.Fatal(err)
	}
	eq(t, len(m.calls), 3)

	m.calls = nil
	m.handler = func(*http.Request, int) (int, any, map[string]string) {
		return 502, map[string]any{"message": "boom"}, nil
	}
	_, err := c.SearchDevices(ctx, DeviceSearchOptions{})
	if !IsStatus(err, 502) {
		t.Fatalf("want 502, got %v", err)
	}
	eq(t, len(m.calls), 1)
}

func TestB07NetworkErrorRetriedForGet(t *testing.T) {
	m := newMock(t)
	var n int32
	rt := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/oauth/token" && atomic.AddInt32(&n, 1) == 1 {
			return nil, errors.New("connection reset")
		}
		return http.DefaultTransport.RoundTrip(r)
	})
	clk := &fakeClock{now: time.Unix(1_800_000_000, 0)}
	c, _ := New(Config{Host: m.srv.URL, ClientID: "a", ClientSecret: "b", BaseDelay: time.Millisecond,
		HTTPClient: &http.Client{Transport: rt}, Sleep: clk.Sleep, Now: clk.Now})
	s, err := c.ServerStatus(ctx)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, s.Version, "3.20.0")
	eq(t, len(clk.sleeps), 1)
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestB07B09FourHundredsNotRetried(t *testing.T) {
	m := newMock(t)
	c, _ := newClient(t, m)
	m.handler = func(*http.Request, int) (int, any, map[string]string) {
		return 403, map[string]any{"message": "This action is unauthorized."}, nil
	}
	_, err := c.GetDevice(ctx, 42)
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("want APIError, got %v", err)
	}
	eq(t, apiErr.Status, 403)
	eq(t, apiErr.Method, "GET")
	eq(t, apiErr.Path, "/devices/42")
	eq(t, apiErr.Body.(map[string]any)["message"].(string), "This action is unauthorized.")
	eq(t, len(m.calls), 1)
}

func TestB08RateLimitHold(t *testing.T) {
	m := newMock(t)
	c, clk := newClient(t, m)
	reset := clk.now.Unix() + 5
	m.handler = func(*http.Request, int) (int, any, map[string]string) {
		return 200, fixture(t, "server-status.json"), map[string]string{
			"X-RateLimit-Limit": "60", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": fmt.Sprint(reset),
		}
	}
	_, _ = c.ServerStatus(ctx)
	rl := c.LastRateLimit()
	eq(t, *rl.Limit, int64(60))
	eq(t, *rl.Remaining, int64(0))
	eq(t, *rl.Reset, reset)
	_, _ = c.ServerStatus(ctx)
	eq(t, len(clk.sleeps), 1)
	eq(t, clk.sleeps[0], 5*time.Second)
}

func TestB10Configuration(t *testing.T) {
	cases := []Config{
		{Host: "not a url", ClientID: "a", ClientSecret: "b"},
		{Host: "ftp://x.kpax.cloud", ClientID: "a", ClientSecret: "b"},
		{Host: "https://x.kpax.cloud", ClientID: "a", ClientSecret: " "},
		{Host: "https://x.kpax.cloud", ClientID: "", ClientSecret: "b"},
	}
	for _, cfg := range cases {
		_, err := New(cfg)
		var ce *ConfigError
		if !errors.As(err, &ce) {
			t.Fatalf("%+v: want ConfigError, got %v", cfg, err)
		}
	}
	c, err := New(Config{Host: " https://acme.kpax.cloud/api/v1/ ", ClientID: "a", ClientSecret: "b"})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, c.Host(), "https://acme.kpax.cloud")
}

func TestB11B12B18IterateDevices(t *testing.T) {
	m := newMock(t)
	c, _ := newClient(t, m)
	m.handler = func(r *http.Request, _ int) (int, any, map[string]string) {
		return 200, fixture(t, "devices-page-"+r.URL.Query().Get("page")+".json"), nil
	}
	devices, err := Collect(c.Devices(ctx, DeviceListOptions{Scope: &Scope{ParentType: "account", ParentID: 12, WithChildren: Bool(true)}}))
	if err != nil {
		t.Fatal(err)
	}
	ids := []int64{}
	for _, d := range devices {
		ids = append(ids, int64(d.ID))
	}
	eq(t, fmt.Sprint(ids), "[1 2 3 4]")
	eq(t, devices[0].Model, "TASKalfa 2554ci")
	q := m.calls[0].URL.Query()
	eq(t, q.Encode(), "page=1&parent_id=12&parent_type=account&per_page=1000&schema=core&with_children=true")
}

func TestB12PerPageOnlyWithCore(t *testing.T) {
	m := newMock(t)
	c, _ := newClient(t, m)
	m.handler = func(*http.Request, int) (int, any, map[string]string) {
		return 200, map[string]any{"data": []any{}}, nil
	}
	_, _ = c.ListDevices(ctx, DeviceListOptions{Schema: "full", PerPage: 500})
	eq(t, m.calls[0].URL.Query().Has("per_page"), false)
}

func TestB11B18IterateAccounts(t *testing.T) {
	m := newMock(t)
	c, _ := newClient(t, m)
	m.handler = func(r *http.Request, _ int) (int, any, map[string]string) {
		return 200, fixture(t, "accounts-page-"+r.URL.Query().Get("page")+".json"), nil
	}
	accounts, err := Collect(c.Accounts(ctx, AccountListOptions{}))
	if err != nil {
		t.Fatal(err)
	}
	eq(t, len(accounts), 3)
	eq(t, int64(accounts[1].ID), int64(11))
	eq(t, int64(accounts[1].ParentID), int64(1))
}

func TestB13FindDeviceBySerial(t *testing.T) {
	m := newMock(t)
	c, _ := newClient(t, m)
	m.handler = func(*http.Request, int) (int, any, map[string]string) {
		return 200, fixture(t, "serial-search.json"), nil
	}
	d, err := c.FindDeviceBySerial(ctx, " abcd123456789 ", nil)
	if err != nil || d == nil {
		t.Fatalf("got %v %v", d, err)
	}
	eq(t, int64(d.ID), int64(7))
	eq(t, m.calls[0].URL.Query().Get("serial_number"), "ABCD123456789")
	d, _ = c.FindDeviceBySerial(ctx, "xyz987654321", nil)
	eq(t, int64(d.ID), int64(9))
	d, err = c.FindDeviceBySerial(ctx, "ABCD12345678", nil)
	if err != nil || d != nil {
		t.Fatalf("want nil, got %v %v", d, err)
	}
	if _, err := c.FindDeviceBySerial(ctx, "ABC", nil); !errors.Is(err, ErrSerialTooShort) {
		t.Fatalf("want ErrSerialTooShort, got %v", err)
	}
}

func TestB13Ambiguous(t *testing.T) {
	m := newMock(t)
	c, _ := newClient(t, m)
	dup := fixture(t, "serial-search.json").(map[string]any)
	dup["data"].([]any)[1].(map[string]any)["serial_number"] = "ABCD123456789"
	m.handler = func(*http.Request, int) (int, any, map[string]string) { return 200, dup, nil }
	_, err := c.FindDeviceBySerial(ctx, "ABCD123456789", nil)
	if !IsStatus(err, 409) {
		t.Fatalf("want 409, got %v", err)
	}
}

func TestB14SearchDevicesForm(t *testing.T) {
	m := newMock(t)
	c, _ := newClient(t, m)
	m.handler = func(*http.Request, int) (int, any, map[string]string) {
		return 200, map[string]any{"data": []any{}, "meta": map[string]any{"current_page": 1, "last_page": 1}}, nil
	}
	_, err := c.SearchDevices(ctx, DeviceSearchOptions{
		Scope:                   &Scope{ParentType: "account", ParentID: 3, WithChildren: Bool(true)},
		Attributes:              []AttributeRef{{"kpax.core.print.devices", "engine_count"}},
		Filters:                 []SearchFilter{{"kpax.core.print.devices", "last_check", "greater", "2026-11-01 00:00:00"}},
		AttributesWithLastCheck: Bool(false),
		ProfileIDs:              []int64{1, 4},
		PerPage:                 500,
	})
	if err != nil {
		t.Fatal(err)
	}
	r := m.calls[0]
	eq(t, r.Method, "POST")
	eq(t, r.URL.Path, "/api/v1/devices/search")
	eq(t, r.Header.Get("Content-Type"), "application/x-www-form-urlencoded")
	f, _ := url.ParseQuery(m.bodies[0])
	eq(t, f.Get("with_children"), "1")
	eq(t, f.Get("attributes_with_last_check"), "0")
	eq(t, f.Get("attributes"), `[{"namespace":"kpax.core.print.devices","name":"engine_count"}]`)
	eq(t, strings.Contains(f.Get("filters"), `"operator":"greater"`), true)
	eq(t, f.Get("profile_id"), "1,4")
	eq(t, f.Get("per_page"), "500")
}

func TestB15Volumes(t *testing.T) {
	m := newMock(t)
	c, _ := newClient(t, m)
	m.handler = func(*http.Request, int) (int, any, map[string]string) { return 200, fixture(t, "volumes.json"), nil }
	v, err := c.GetDeviceVolumes(ctx, 42, VolumeOptions{StartDate: "2026-11-01", EndDate: "2026-11-02", VolumeName: "engine_count"})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v["engine_count"]["2026-11-01"], 120.0)
	eq(t, m.calls[0].URL.Path, "/api/v1/devices/42/volumes")
	eq(t, m.calls[0].URL.Query().Encode(), "end_date=2026-11-02&interval=daily&start_date=2026-11-01&volume_name=engine_count")
}

func TestB16QueryAndPathEncoding(t *testing.T) {
	m := newMock(t)
	c, _ := newClient(t, m)
	m.handler = func(*http.Request, int) (int, any, map[string]string) {
		return 200, fixture(t, "supply-cycles.json"), nil
	}
	cycles, err := c.GetSupplyCycles(ctx, 9, "black", 0)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, cycles[0]["ref_part_number"].(string), "TK-8345K")
	eq(t, m.calls[0].URL.RawQuery, "cartridge=black")
	m.handler = func(*http.Request, int) (int, any, map[string]string) { return 200, map[string]any{}, nil }
	_ = c.Do(ctx, "GET", "/devices/{id}", RequestOptions{PathParams: map[string]any{"id": "a/b"}, Query: map[string]any{"x": nil}}, nil)
	eq(t, m.calls[1].URL.EscapedPath(), "/api/v1/devices/a%2Fb")
	eq(t, m.calls[1].URL.RawQuery, "")
}

func TestB11AlertHistoryAllPages(t *testing.T) {
	m := newMock(t)
	c, _ := newClient(t, m)
	m.handler = func(r *http.Request, _ int) (int, any, map[string]string) {
		return 200, fixture(t, "alerts-page-"+r.URL.Query().Get("page")+".json"), nil
	}
	ev, err := c.GetTechnicalAlertHistory(ctx, 42, DateRange{})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, len(ev), 2)
	eq(t, ev[0].Value, "Toner low")
	eq(t, int64(ev[0].Occurrences), int64(4))
	eq(t, ev[1].EventEndDate == nil, true)
}

func TestFullDeviceKeepsRaw(t *testing.T) {
	m := newMock(t)
	c, _ := newClient(t, m)
	m.handler = func(*http.Request, int) (int, any, map[string]string) {
		return 200, fixture(t, "device-full.json"), nil
	}
	d, err := c.GetDevice(ctx, 42)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, d.SerialNumber, "SN0000000042")
	raw, _ := d.RawMap()
	eq(t, raw["meters"].(map[string]any)["engine_count"].(map[string]any)["value"].(float64), 152340.0)
}

func TestB17TestConnection(t *testing.T) {
	m := newMock(t)
	c, _ := newClient(t, m)
	eq(t, c.TestConnection(ctx).OK, true)
	m.tokenH = func() (int, any) { return 401, map[string]any{"error": "invalid_client"} }
	c.invalidateToken()
	res := c.TestConnection(ctx)
	eq(t, res.OK, false)
	eq(t, res.Stage, "auth")
	eq(t, res.Status, 401)
	cfg := TestCredentials(ctx, Config{Host: "nope", ClientID: "a", ClientSecret: "b"})
	eq(t, cfg.Stage, "config")
}

func TestContextCancellationStopsRetries(t *testing.T) {
	m := newMock(t)
	m.handler = func(*http.Request, int) (int, any, map[string]string) { return 503, map[string]any{}, nil }
	c, _ := New(Config{Host: m.srv.URL, ClientID: "a", ClientSecret: "b", BaseDelay: time.Hour})
	cctx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	_, err := c.ServerStatus(cctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want deadline exceeded, got %v", err)
	}
}
