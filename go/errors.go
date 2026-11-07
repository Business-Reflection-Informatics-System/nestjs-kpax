package kpax

import (
	"encoding/json"
	"errors"
	"fmt"
)

// ErrSerialTooShort is returned by serial searches with fewer than 5 characters.
var ErrSerialTooShort = errors.New("kpax: serial-number search needs at least 5 characters")

// ConfigError reports an invalid host or missing credentials (B10).
type ConfigError struct{ Msg string }

func (e *ConfigError) Error() string { return "kpax: " + e.Msg }

// AuthError means the /oauth/token endpoint refused the credentials or was
// unreachable (Status 0) (B05).
type AuthError struct {
	Status int
	Host   string
	Body   any
}

func (e *AuthError) Error() string {
	return fmt.Sprintf("kpax: token request to %s failed with HTTP %d%s", e.Host, e.Status, describe(e.Body))
}

// APIError is a non-2xx KPAX response after retries (B09). Status is 0 for a
// network error that persisted through retries. KPAX uses 401 both for bad
// tokens and missing scopes, and 403 for resources outside the client's level.
type APIError struct {
	Status int
	Method string
	Path   string
	Body   any
	Msg    string
}

func (e *APIError) Error() string {
	if e.Msg != "" {
		return "kpax: " + e.Msg
	}
	return fmt.Sprintf("kpax: %s %s failed with HTTP %d%s", e.Method, e.Path, e.Status, describe(e.Body))
}

// IsStatus reports whether err is an *APIError with the given status.
func IsStatus(err error, status int) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == status
}

func describe(body any) string {
	switch b := body.(type) {
	case nil:
		return ""
	case string:
		if b == "" {
			return ""
		}
		if len(b) > 300 {
			b = b[:300]
		}
		return ": " + b
	case map[string]any:
		for _, k := range []string{"message", "error_description", "error"} {
			if s, ok := b[k].(string); ok {
				return ": " + s
			}
		}
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return ""
	}
	s := string(raw)
	if len(s) > 300 {
		s = s[:300]
	}
	return ": " + s
}
