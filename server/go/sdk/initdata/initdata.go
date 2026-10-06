// Package initdata verifies registered LO mini-app launch data using only stdlib.
package initdata

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type Error struct{ Code string }

func (e *Error) Error() string  { return e.Code }
func invalid(code string) error { return &Error{Code: code} }

type Options struct {
	AppKey    string
	AppID     string
	MaxAgeSec int64
	// Now overrides the clock for tests; its zero value uses time.Now().
	Now time.Time
}
type User struct {
	ID           string `json:"id"`
	FirstName    string `json:"firstName,omitempty"`
	LastName     string `json:"lastName,omitempty"`
	Username     string `json:"username,omitempty"`
	PhotoURL     string `json:"photoUrl,omitempty"`
	LanguageCode string `json:"languageCode,omitempty"`
}
type Data struct {
	User       *User  `json:"user,omitempty"`
	AuthDate   int64  `json:"authDate"`
	AppID      string `json:"appId"`
	StartParam string `json:"startParam,omitempty"`
	ChatType   string `json:"chatType,omitempty"`
	QueryID    string `json:"queryId,omitempty"`
}

var decimal = regexp.MustCompile(`^[0-9]+$`)
var userID = regexp.MustCompile(`^[1-9][0-9]*$`)

const maxSafeInteger int64 = 9007199254740991

// Verify authenticates the exact decoded values before returning a user identity.
// AppKey is the LO Connect key as supplied, without base64 decoding.
func Verify(raw string, options Options) (Data, error) {
	var empty Data
	if options.AppKey == "" || options.AppID == "" || options.MaxAgeSec < 0 || options.MaxAgeSec > maxSafeInteger {
		return empty, errors.New("invalid verification options")
	}
	now := options.Now
	if now.IsZero() {
		now = time.Now()
	}
	nowSec := now.Unix()
	if nowSec < 0 || nowSec > maxSafeInteger {
		return empty, errors.New("invalid clock")
	}
	if len(raw) > 65536 {
		return empty, invalid("invalid-data")
	}
	params := make(map[string]string)
	for _, pair := range strings.Split(raw, "&") {
		if pair == "" {
			continue
		}
		key, value, _ := strings.Cut(pair, "=")
		key, err := url.QueryUnescape(key)
		if err != nil || key == "" || !utf8.ValidString(key) {
			return empty, invalid("invalid-data")
		}
		value, err = url.QueryUnescape(value)
		if err != nil || !utf8.ValidString(value) {
			return empty, invalid("invalid-data")
		}
		if _, exists := params[key]; exists {
			return empty, invalid("duplicate-parameter")
		}
		params[key] = value
	}
	hash, err := hex.DecodeString(params["hash"])
	if err != nil || len(hash) != sha256.Size {
		return empty, invalid("invalid-signature")
	}
	keys := make([]string, 0, len(params))
	for key := range params {
		if key != "hash" && key != "signature" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	lines := make([]string, len(keys))
	for i, key := range keys {
		lines[i] = key + "=" + params[key]
	}
	secret := hmac.New(sha256.New, []byte("WebAppData"))
	secret.Write([]byte(options.AppKey))
	signed := hmac.New(sha256.New, secret.Sum(nil))
	signed.Write([]byte(strings.Join(lines, "\n")))
	if !hmac.Equal(signed.Sum(nil), hash) {
		return empty, invalid("invalid-signature")
	}
	if params["app_id"] != options.AppID {
		return empty, invalid("wrong-app-id")
	}
	date := params["auth_date"]
	if !decimal.MatchString(date) {
		return empty, invalid("invalid-data")
	}
	authDate, err := strconv.ParseInt(date, 10, 64)
	if err != nil || authDate > maxSafeInteger {
		return empty, invalid("invalid-data")
	}
	if authDate > nowSec+300 {
		return empty, invalid("future-auth-date")
	}
	if nowSec-authDate > options.MaxAgeSec {
		return empty, invalid("expired")
	}
	data := Data{AuthDate: authDate, AppID: options.AppID, StartParam: params["start_param"], ChatType: params["chat_type"], QueryID: params["query_id"]}
	if rawUser, exists := params["user"]; exists {
		user, err := parseUser(rawUser)
		if err != nil {
			return empty, invalid("invalid-data")
		}
		data.User = user
	}
	return data, nil
}
func parseUser(raw string) (*User, error) {
	if !json.Valid([]byte(raw)) {
		return nil, errors.New("invalid user")
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return nil, errors.New("invalid user")
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key := token.(string)
		if _, exists := fields[key]; exists && key == "id" {
			return nil, errors.New("duplicate user id")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		fields[key] = value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("invalid user")
	}
	var id string
	if value := fields["id"]; len(value) != 0 && value[0] == '"' {
		_ = json.Unmarshal(value, &id)
	} else {
		id = string(fields["id"])
	}
	if !userID.MatchString(id) {
		return nil, errors.New("invalid user id")
	}
	get := func(key string) string { var s string; _ = json.Unmarshal(fields[key], &s); return s }
	photo := get("photo_url")
	u, err := url.Parse(photo)
	if err != nil || strings.TrimSpace(photo) != photo || !strings.EqualFold(u.Scheme, "https") || !strings.HasSuffix(strings.ToLower(u.Hostname()), ".lo.ink") || u.User != nil || (u.Port() != "" && u.Port() != "443") || strings.ContainsAny(photo, "\x00\r\n\t") {
		photo = ""
	}
	return &User{ID: id, FirstName: get("first_name"), LastName: get("last_name"), Username: get("username"), PhotoURL: photo, LanguageCode: get("language_code")}, nil
}
