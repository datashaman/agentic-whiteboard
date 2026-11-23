package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func TestBoardCreationRequiresTheServerCredentialAndReplaysSafely(t *testing.T) {
	f := newAPIFixture(t)
	const origin = "https://central.example.test"
	secret := strings.Repeat("ab", 32)
	creation, err := newBoardCreation(secret, origin)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(newHandler(f.db, "", creation))
	t.Cleanup(server.Close)
	const body = `{"slug":"new-board","name":"New board","actor":"Creator"}`
	const key = "60e3070c-1b5e-48dc-9ba5-11dc18e23be6"

	request := func(method, callerOrigin, token, submission, payload string, status int) *http.Response {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+"/api/boards", strings.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		if callerOrigin != "" {
			req.Header.Set("Origin", callerOrigin)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if submission != "" {
			req.Header.Set("Idempotency-Key", submission)
		}
		res, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = res.Body.Close() })
		if res.StatusCode != status {
			t.Fatalf("%s returned HTTP %d, want %d", method, res.StatusCode, status)
		}
		return res
	}

	unconfigured := httptest.NewRecorder()
	newHandler(f.db, "", nil).ServeHTTP(unconfigured, httptest.NewRequest(http.MethodPost, "/api/boards", nil))
	if unconfigured.Code != http.StatusNotFound {
		t.Fatalf("creation without configuration returned HTTP %d", unconfigured.Code)
	}
	wrongOrigin := request(http.MethodOptions, "https://other.example.test", "", "", "", http.StatusForbidden)
	if got := wrongOrigin.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatal("an unapproved origin received CORS access")
	}
	request(http.MethodPost, "https://other.example.test", secret, key, body, http.StatusForbidden)
	preflight := request(http.MethodOptions, origin, "", "", "", http.StatusNoContent)
	if preflight.Header.Get("Access-Control-Allow-Origin") != origin ||
		!strings.Contains(preflight.Header.Get("Access-Control-Allow-Headers"), "Idempotency-Key") {
		t.Fatal("the approved origin is missing its preflight headers")
	}
	_, existingToken := f.token(t, "demo", "Maintainer", "post,read,take")
	request(http.MethodPost, origin, existingToken, key, body, http.StatusUnauthorized)
	request(http.MethodPost, origin, secret, "", body, http.StatusBadRequest)
	request(http.MethodPost, origin, secret, key, strings.Replace(body, "new-board", "../bad", 1), http.StatusBadRequest)

	created := request(http.MethodPost, origin, secret, key, body, http.StatusCreated)
	if created.Header.Get("Access-Control-Allow-Origin") != origin || created.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("the credential response must be readable by the approved origin and uncacheable")
	}
	var reply struct {
		ID      string
		TokenID string
		Token   string
	}
	if err := json.NewDecoder(created.Body).Decode(&reply); err != nil || reply.ID != "new-board" || reply.TokenID == "" || reply.Token == "" {
		t.Fatal("creation did not return access to the new board")
	}
	var replayed = reply
	replay := request(http.MethodPost, origin, secret, key, body, http.StatusCreated)
	if err := json.NewDecoder(replay.Body).Decode(&replayed); err != nil || replayed != reply {
		t.Fatal("retry did not return the original credential")
	}
	request(http.MethodPost, origin, secret, "1cee632a-1ca6-47c7-aa57-a03ea7051dc4", body, http.StatusConflict)
	request(http.MethodPost, origin, secret, key, strings.Replace(body, "Creator", "Another person", 1), http.StatusConflict)

	var access boardAccess
	f.call(t, http.MethodGet, reply.ID, reply.Token, "", "", http.StatusOK, &access)
	if access.Actor != "Creator" || access.Name != "New board" || !slices.Equal(access.Permissions, []string{"post", "read", "take"}) {
		t.Fatalf("unexpected initial access: %+v", access)
	}
	f.call(t, http.MethodGet, reply.ID, secret, "", "", http.StatusUnauthorized, nil)
	f.call(t, http.MethodGet, "demo", reply.Token, "", "", http.StatusUnauthorized, nil)
	f.operator(t, "token", "revoke", reply.ID, reply.TokenID)
	revoked := request(http.MethodPost, origin, secret, key, body, http.StatusConflict)
	if data, err := io.ReadAll(revoked.Body); err != nil || strings.Contains(string(data), reply.Token) {
		t.Fatal("retry exposed the revoked credential")
	}
}
