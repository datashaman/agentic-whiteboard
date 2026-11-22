package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type apiFixture struct {
	config *pgxpool.Config
	db     *pgxpool.Pool
	server *httptest.Server
}

func newAPIFixture(t *testing.T) *apiFixture {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	admin, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	schema := "whiteboard_test_" + hex.EncodeToString(random)
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := admin.Exec(ctx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Error(err)
		}
	})
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	fixture := &apiFixture{config: config}
	fixture.start(t, "")
	fixture.operator(t, "migrate")
	fixture.operator(t, "board", "create", "demo", "Demo whiteboard")
	return fixture
}

func (f *apiFixture) start(t *testing.T, webDir string) {
	t.Helper()
	db, err := pgxpool.NewWithConfig(context.Background(), f.config.Copy())
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(newHandler(db, webDir))
	f.db, f.server = db, server
	t.Cleanup(func() {
		server.Close()
		db.Close()
	})
}

func (f *apiFixture) operator(t *testing.T, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var output strings.Builder
	if err := runOperator(ctx, f.db, &output, args); err != nil {
		t.Fatalf("%v: %v", args, err)
	}
	return output.String()
}

func (f *apiFixture) token(t *testing.T, board, actor, permissions string) (id, secret string) {
	t.Helper()
	output := f.operator(t, "token", "issue", board, actor, permissions)
	var issued struct{ ID, Token string }
	if err := json.Unmarshal([]byte(output), &issued); err != nil || issued.ID == "" || issued.Token == "" {
		t.Fatalf("invalid token issue output: %v", err)
	}
	return issued.ID, issued.Token
}

type apiResponse struct {
	status int
	body   []byte
	err    error
}

func (f *apiFixture) request(ctx context.Context, method, path, token, key, body string) apiResponse {
	req, err := http.NewRequestWithContext(ctx, method, f.server.URL+"/api/boards/"+path, strings.NewReader(body))
	if err != nil {
		return apiResponse{err: err}
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := f.server.Client().Do(req)
	if err != nil {
		return apiResponse{err: err}
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	return apiResponse{status: res.StatusCode, body: raw, err: err}
}

func (r apiResponse) want(t *testing.T, status int, destination any) {
	t.Helper()
	if r.err != nil || r.status != status {
		t.Fatalf("wanted HTTP %d, got %d: %s (%v)", status, r.status, r.body, r.err)
	}
	if destination != nil {
		if err := json.Unmarshal(r.body, destination); err != nil {
			t.Fatalf("invalid response %s: %v", r.body, err)
		}
	} else if status == http.StatusNoContent && len(r.body) != 0 {
		t.Fatalf("no-content response has body %q", r.body)
	}
}

func (f *apiFixture) call(t *testing.T, method, path, token, key, body string, status int, destination any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	f.request(ctx, method, path, token, key, body).want(t, status, destination)
}

func TestBoardTokensAreScopedAndRevocable(t *testing.T) {
	f := newAPIFixture(t)
	f.operator(t, "migrate")
	f.operator(t, "board", "create", "other", "Other board")
	id, alice := f.token(t, "demo", "Alice", "post,read,take")

	var board struct {
		ID, Name, Actor string
		Permissions     []string
	}
	f.call(t, "GET", "demo", alice, "", "", 200, &board)
	if board.ID != "demo" || board.Name != "Demo whiteboard" || board.Actor != "Alice" ||
		!slices.Equal(board.Permissions, []string{"post", "read", "take"}) {
		t.Fatalf("unexpected board metadata: %+v", board)
	}
	for _, tc := range []struct{ path, token string }{
		{"demo", ""},
		{"demo", "unknown"},
		{"other", alice},
	} {
		t.Run(fmt.Sprintf("%s/%t", tc.path, tc.token != ""), func(t *testing.T) {
			var failure struct{ Code, Message string }
			f.call(t, "GET", tc.path, tc.token, "", "", 401, &failure)
			if failure.Code == "" || failure.Message == "" {
				t.Fatalf("missing typed error: %+v", failure)
			}
		})
	}

	f.operator(t, "token", "revoke", "demo", id)
	f.call(t, "GET", "demo", alice, "", "", 401, nil)
}

type observedEntry struct {
	ID       string
	Payload  json.RawMessage
	PostedAt time.Time
}

func (f *apiFixture) post(t *testing.T, token, key, payload string) observedEntry {
	t.Helper()
	var entry observedEntry
	f.call(t, "POST", "demo/entries", token, key, `{"payload":`+payload+`}`, 201, &entry)
	if entry.ID == "" || entry.PostedAt.IsZero() {
		t.Fatalf("post did not return entry metadata: %+v", entry)
	}
	return entry
}

func (f *apiFixture) browse(t *testing.T, token, pattern string) []observedEntry {
	t.Helper()
	var response struct{ Entries []observedEntry }
	f.call(t, "POST", "demo/browse", token, "", `{"pattern":`+pattern+`}`, 200, &response)
	if response.Entries == nil {
		t.Fatal("browse should return a JSON array")
	}
	return response.Entries
}

func assertEntries(t *testing.T, entries []observedEntry, want ...string) {
	t.Helper()
	got := make([]string, len(entries))
	for i, entry := range entries {
		got[i] = entry.ID
	}
	if !slices.Equal(got, want) {
		t.Fatalf("wanted entries %v, got %v", want, got)
	}
}

func TestBrowseMatchesExactTopLevelValuesOldestFirst(t *testing.T) {
	f := newAPIFixture(t)
	_, token := f.token(t, "demo", "Alice", "post,read")
	absent := f.post(t, token, "absent", `{"kind":"work"}`)
	oldest := f.post(t, token, "oldest", `{"kind":"work","task":null,"details":{"x":[1,2],"y":true},"n":9007199254740993,"": "empty key"}`)
	newest := f.post(t, token, "newest", `{"kind":"work","task":null,"details":{"x":[2,1],"y":true},"n":9007199254740992}`)
	unusual := f.post(t, token, "unusual", `{"\u0000":"\u0000","n":1e1000000,"numericString":"1e1000000"}`)
	f.operator(t, "board", "create", "other", "Other board")
	_, other := f.token(t, "other", "Bob", "post,read")
	f.call(t, "POST", "other/entries", other, "other", `{"payload":{"kind":"work"}}`, 201, nil)

	for _, tc := range []struct {
		pattern string
		want    []string
	}{
		{`{}`, []string{absent.ID, oldest.ID, newest.ID, unusual.ID}},
		{`{"kind":"work"}`, []string{absent.ID, oldest.ID, newest.ID}},
		{`{"task":null}`, []string{oldest.ID, newest.ID}},
		{`{"details":{"y":true,"x":[1,2]},"n":9007199254740993.0}`, []string{oldest.ID}},
		{`{"details":{"x":[1]}}`, nil},
		{`{"details":{"x":[1,2]}}`, nil},
		{`{"details":{"x":[1,2],"y":true},"n":9007199254740992}`, nil},
		{`{"":"empty key"}`, []string{oldest.ID}},
		{`{"\u0000":"\u0000","n":10e999999}`, []string{unusual.ID}},
		{`{"n":"1e1000000"}`, nil},
		{`{"numericString":1e1000000}`, nil},
		{`{"x' OR true --":null}`, nil},
	} {
		t.Run(tc.pattern, func(t *testing.T) {
			assertEntries(t, f.browse(t, token, tc.pattern), tc.want...)
		})
	}
	if !strings.Contains(string(oldest.Payload), "9007199254740993") ||
		!strings.Contains(string(unusual.Payload), "1e1000000") {
		t.Fatalf("post changed numeric payloads: %s, %s", oldest.Payload, unusual.Payload)
	}
}

func TestReadReturnsOldestMatchWithoutTakingIt(t *testing.T) {
	f := newAPIFixture(t)
	_, token := f.token(t, "demo", "Alice", "post,read")
	f.call(t, "POST", "demo/read", token, "", `{"pattern":{}}`, 204, nil)
	f.post(t, token, "other-kind", `{"kind":"note"}`)
	first := f.post(t, token, "first-work", `{"kind":"work","ordinal":1}`)
	second := f.post(t, token, "second-work", `{"kind":"work","ordinal":2}`)
	var read observedEntry
	f.call(t, "POST", "demo/read", token, "", `{"pattern":{"kind":"work"}}`, 200, &read)
	if read.ID != first.ID || string(read.Payload) != string(first.Payload) {
		t.Fatalf("read returned %+v, want %+v", read, first)
	}
	assertEntries(t, f.browse(t, token, `{"kind":"work"}`), first.ID, second.ID)
}

func TestConcurrentTakeClaimsOneEntryAndExactTakeKeepsItsTarget(t *testing.T) {
	f := newAPIFixture(t)
	_, alice := f.token(t, "demo", "Alice", "post,read,take")
	_, bob := f.token(t, "demo", "Bob", "take")
	now := time.Now()
	f.call(t, "POST", "demo/take", alice, "empty", `{"pattern":{}}`, 204, nil)
	if elapsed := time.Since(now); elapsed > time.Second {
		t.Fatalf("take without waitMs took %s", elapsed)
	}
	original := f.post(t, alice, "only", `{"kind":"work","large":9007199254740993}`)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := make(chan struct{})
	results := make(chan apiResponse, 2)
	for _, token := range []string{alice, bob} {
		go func() {
			<-start
			results <- f.request(ctx, "POST", "demo/take", token, "claim", `{"pattern":{"kind":"work"}}`)
		}()
	}
	close(start)
	first, second := <-results, <-results
	if second.status == 200 {
		first, second = second, first
	}
	var taken observedEntry
	first.want(t, 200, &taken)
	second.want(t, 204, nil)
	if taken.ID != original.ID || string(taken.Payload) != string(original.Payload) {
		t.Fatalf("take returned %+v, want %+v", taken, original)
	}

	oldest := f.post(t, alice, "older", `{"kind":"work"}`)
	target := f.post(t, alice, "target", `{"kind":"work"}`)
	body := fmt.Sprintf(`{"entryId":%q}`, target.ID)
	f.call(t, "POST", "demo/take", bob, "exact", body, 200, &taken)
	if taken.ID != target.ID {
		t.Fatalf("exact take returned %s, want %s", taken.ID, target.ID)
	}
	var failure struct{ Code string }
	f.call(t, "POST", "demo/take", alice, "loser", body, 409, &failure)
	if failure.Code != "already_taken" {
		t.Fatalf("wrong conflict code %q", failure.Code)
	}
	f.call(t, "POST", "demo/take", alice, "missing", `{"entryId":"does-not-exist"}`, 404, nil)
	assertEntries(t, f.browse(t, alice, `{}`), oldest.ID)
	var exactTakes, patternTakes int
	for _, event := range f.history(t, alice) {
		if event.Operation != "take" {
			continue
		}
		switch event.Entry.ID {
		case original.ID:
			patternTakes++
			if event.Actor != "Alice" && event.Actor != "Bob" {
				t.Fatalf("unexpected actor for concurrent take: %+v", event)
			}
			assertEvent(t, event, "take", event.Actor, original)
		case target.ID:
			exactTakes++
			assertEvent(t, event, "take", "Bob", target)
		default:
			t.Fatalf("unexpected take: %+v", event)
		}
	}
	if patternTakes != 1 || exactTakes != 1 {
		t.Fatalf("wanted one event per successful take, got %d pattern and %d exact", patternTakes, exactTakes)
	}
}

func TestWaitTimesOutOrCompletesAfterAMatchingPost(t *testing.T) {
	f := newAPIFixture(t)
	_, token := f.token(t, "demo", "Alice", "post,read,take")
	f.call(t, "POST", "demo/read", token, "", `{"pattern":{},"waitMs":30001}`, 400, nil)
	f.call(t, "POST", "demo/take", token, "invalid", `{"pattern":{},"waitMs":-1}`, 400, nil)

	start := time.Now()
	f.call(t, "POST", "demo/take", token, "pending", `{"pattern":{"kind":"work"},"waitMs":140}`, 204, nil)
	if elapsed := time.Since(start); elapsed < 100*time.Millisecond || elapsed > 2*time.Second {
		t.Fatalf("bounded wait took %s", elapsed)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pending := make(chan apiResponse, 1)
	go func() {
		pending <- f.request(ctx, "POST", "demo/read", token, "", `{"pattern":{"kind":"work"},"waitMs":3000}`)
	}()
	f.post(t, token, "nonmatch", `{"kind":"note"}`)
	select {
	case result := <-pending:
		t.Fatalf("read ended before a matching post: %+v", result)
	case <-time.After(120 * time.Millisecond):
	}
	posted := f.post(t, token, "match", `{"kind":"work"}`)
	var result observedEntry
	(<-pending).want(t, 200, &result)
	if result.ID != posted.ID {
		t.Fatalf("waiting read returned %s, want %s", result.ID, posted.ID)
	}
	f.call(t, "POST", "demo/take", token, "pending", `{"pattern":{"kind":"work"}}`, 200, &result)
	if result.ID != posted.ID {
		t.Fatalf("retry after no match took %s, want %s", result.ID, posted.ID)
	}
	go func() {
		pending <- f.request(ctx, "POST", "demo/take", token, "wait-for-take", `{"pattern":{"kind":"work"},"waitMs":2000}`)
	}()
	select {
	case result := <-pending:
		t.Fatalf("take ended before a matching post: %+v", result)
	case <-time.After(80 * time.Millisecond):
	}
	posted = f.post(t, token, "match-for-take", `{"kind":"work"}`)
	(<-pending).want(t, 200, &result)
	if result.ID != posted.ID {
		t.Fatalf("waiting take returned %s, want %s", result.ID, posted.ID)
	}
	assertEntries(t, f.browse(t, token, `{"kind":"work"}`))
}

func TestCancellingPendingTakeLeavesLaterPostAvailable(t *testing.T) {
	f := newAPIFixture(t)
	_, token := f.token(t, "demo", "Alice", "post,read,take")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pending := make(chan apiResponse, 1)
	go func() {
		pending <- f.request(ctx, "POST", "demo/take", token, "cancelled", `{"pattern":{"issue":1},"waitMs":30000}`)
	}()
	select {
	case result := <-pending:
		t.Fatalf("take ended before cancellation: %+v", result)
	case <-time.After(120 * time.Millisecond):
	}
	cancel()
	select {
	case result := <-pending:
		if !errors.Is(result.err, context.Canceled) {
			t.Fatalf("cancelled request returned %+v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled HTTP request did not return")
	}
	posted := f.post(t, token, "later", `{"issue":1}`)
	// Give a request that incorrectly kept polling time to observe the new match.
	time.Sleep(150 * time.Millisecond)
	assertEntries(t, f.browse(t, token, `{"issue":1}`), posted.ID)
	var taken observedEntry
	f.call(t, "POST", "demo/take", token, "fresh", `{"pattern":{"issue":1}}`, 200, &taken)
	if taken.ID != posted.ID {
		t.Fatalf("fresh take returned %s, want %s", taken.ID, posted.ID)
	}
}

type observedEvent struct {
	ID, Operation, Actor string
	At                   time.Time
	Entry                observedEntry
}

func (f *apiFixture) history(t *testing.T, token string) []observedEvent {
	t.Helper()
	var response struct{ Events []observedEvent }
	f.call(t, "GET", "demo/history", token, "", "", 200, &response)
	if response.Events == nil {
		t.Fatal("history should return a JSON array")
	}
	return response.Events
}

func assertEvent(t *testing.T, event observedEvent, operation, actor string, expected observedEntry) {
	t.Helper()
	if event.ID == "" || event.At.IsZero() || event.Operation != operation || event.Actor != actor ||
		event.Entry.ID != expected.ID || !event.Entry.PostedAt.Equal(expected.PostedAt) ||
		string(event.Entry.Payload) != string(expected.Payload) {
		t.Fatalf("event %+v, want %s by %s for %+v", event, operation, actor, expected)
	}
}

func TestHistoryPreservesSuccessfulMutationsAndReplayAcrossRestart(t *testing.T) {
	f := newAPIFixture(t)
	aliceID, alice := f.token(t, "demo", "Alice", "post,read,take")
	_, bob := f.token(t, "demo", "Bob", "post,read,take")
	if events := f.history(t, bob); len(events) != 0 {
		t.Fatalf("new board has history: %+v", events)
	}

	original := f.post(t, alice, "post-request", `{"n":0.01,"kind":"work"}`)
	replayedPost := f.post(t, alice, "post-request", `{"kind":"work","n":1e-2}`)
	replica := f.post(t, alice, "different-request", `{"n":0.01,"kind":"work"}`)
	if replayedPost.ID != original.ID || string(replayedPost.Payload) != string(original.Payload) || replica.ID == original.ID {
		t.Fatalf("post and retry returned %+v, %+v, %+v", original, replayedPost, replica)
	}

	takeBody := `{"pattern":{"kind":"work"}}`
	var claimed observedEntry
	f.call(t, "POST", "demo/take", alice, "take-request", takeBody, 200, &claimed)
	if claimed.ID != original.ID {
		t.Fatalf("take claimed %s, want oldest entry %s", claimed.ID, original.ID)
	}
	var failure struct{ Code string }
	for _, req := range []struct{ route, key, body string }{
		{"entries", "post-request", `{"payload":{"n":0.02,"kind":"work"}}`},
		{"take", "post-request", takeBody},
		{"take", "take-request", `{"pattern":{"kind":"work"},"waitMs":1}`},
		{"take", "take-request", `{"entryId":"` + original.ID + `"}`},
	} {
		f.call(t, "POST", "demo/"+req.route, alice, req.key, req.body, 409, &failure)
		if failure.Code != "request_conflict" {
			t.Fatalf("wrong conflict code %q for %+v", failure.Code, req)
		}
	}

	// A new server and pool must read outcomes and attribution from PostgreSQL.
	f.server.Close()
	f.db.Close()
	f.start(t, "")
	var replayedTake observedEntry
	f.call(t, "POST", "demo/take", alice, "take-request", `{"pattern":{"kind":"work"},"waitMs":0}`, 200, &replayedTake)
	if replayedTake.ID != original.ID || string(replayedTake.Payload) != string(original.Payload) {
		t.Fatalf("take replay returned %+v, want %+v", replayedTake, original)
	}
	f.operator(t, "token", "revoke", "demo", aliceID)
	f.call(t, "POST", "demo/take", alice, "take-request", takeBody, 401, nil)
	events := f.history(t, bob)
	if len(events) != 3 || events[0].At.Before(events[1].At) || events[1].At.Before(events[2].At) {
		t.Fatalf("wanted three events, newest first: %+v", events)
	}
	assertEvent(t, events[0], "take", "Alice", original)
	assertEvent(t, events[1], "post", "Alice", replica)
	assertEvent(t, events[2], "post", "Alice", original)
	assertEntries(t, f.browse(t, bob, `{}`), replica.ID)
}

func TestPermissionsAndRecoveryAreBoardScoped(t *testing.T) {
	f := newAPIFixture(t)
	_, writer := f.token(t, "demo", "Writer", "post")
	_, reader := f.token(t, "demo", "Reader", "read")
	_, worker := f.token(t, "demo", "Worker", "take")
	_, maintainer := f.token(t, "demo", "Maintainer", "read,post")
	f.operator(t, "board", "create", "other", "Other board")
	_, other := f.token(t, "other", "Other operator", "post,read,take")
	for _, tc := range []struct{ token, method, route, body string }{
		{writer, "POST", "browse", `{"pattern":{}}`},
		{writer, "POST", "read", `{"pattern":{}}`},
		{writer, "POST", "take", `{"pattern":{}}`},
		{writer, "GET", "history", ""},
		{reader, "POST", "entries", `{"payload":{}}`},
		{reader, "POST", "take", `{"pattern":{}}`},
		{worker, "POST", "entries", `{"payload":{}}`},
		{worker, "POST", "browse", `{"pattern":{}}`},
		{worker, "POST", "read", `{"pattern":{}}`},
		{worker, "GET", "history", ""},
		{maintainer, "POST", "take", `{"pattern":{}}`},
	} {
		f.call(t, tc.method, "demo/"+tc.route, tc.token, "forbidden", tc.body, 403, nil)
	}
	original := f.post(t, writer, "request", `{"kind":"work","issue":1,"note":null}`)
	assertEntries(t, f.browse(t, reader, `{}`), original.ID)
	var read observedEntry
	f.call(t, "POST", "demo/read", reader, "", `{"pattern":{"note":null}}`, 200, &read)
	if read.ID != original.ID {
		t.Fatalf("reader got %s, want %s", read.ID, original.ID)
	}
	f.call(t, "POST", "other/take", other, "request", fmt.Sprintf(`{"entryId":%q}`, original.ID), 404, nil)
	f.call(t, "POST", "other/entries", writer, "request", `{"payload":{}}`, 401, nil)
	f.call(t, "POST", "other/entries", other, "request", `{"payload":{}}`, 201, nil)
	var taken observedEntry
	f.call(t, "POST", "demo/take", worker, "request", `{"pattern":{"kind":"work"}}`, 200, &taken)
	if taken.ID != original.ID {
		t.Fatalf("worker took %s, want %s", taken.ID, original.ID)
	}

	events := f.history(t, maintainer)
	if len(events) != 2 {
		t.Fatalf("wanted one post and one take: %+v", events)
	}
	assertEvent(t, events[0], "take", "Worker", original)
	assertEvent(t, events[1], "post", "Writer", original)
	recovered := f.post(t, maintainer, "request", string(events[0].Entry.Payload))
	if recovered.ID == original.ID || string(recovered.Payload) != string(original.Payload) {
		t.Fatalf("recovery returned %+v for original %+v", recovered, original)
	}
	assertEntries(t, f.browse(t, reader, `{}`), recovered.ID)
	events = f.history(t, reader)
	if len(events) != 3 {
		t.Fatalf("recovery did not preserve history: %+v", events)
	}
	assertEvent(t, events[0], "post", "Maintainer", recovered)
	assertEvent(t, events[1], "take", "Worker", original)
}

func TestConcurrentRetriesShareOneMutation(t *testing.T) {
	f := newAPIFixture(t)
	_, token := f.token(t, "demo", "Alice", "post,read,take")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	race := func(route, key, body string, status int) [2]observedEntry {
		t.Helper()
		start := make(chan struct{})
		results := make(chan apiResponse, 2)
		for range 2 {
			go func() {
				<-start
				results <- f.request(ctx, "POST", "demo/"+route, token, key, body)
			}()
		}
		close(start)
		var entries [2]observedEntry
		for i := range entries {
			(<-results).want(t, status, &entries[i])
		}
		if entries[0].ID != entries[1].ID || string(entries[0].Payload) != string(entries[1].Payload) {
			t.Fatalf("concurrent retries returned different outcomes: %+v", entries)
		}
		return entries
	}
	posts := race("entries", "post", `{"payload":{"kind":"work"}}`, 201)
	takes := race("take", "take", `{"pattern":{"kind":"work"},"waitMs":1500}`, 200)
	if takes[0].ID != posts[0].ID {
		t.Fatalf("takes %+v did not claim posts %+v", takes, posts)
	}
	events := f.history(t, token)
	if len(events) != 2 {
		t.Fatalf("expected one post and one take: %+v", events)
	}
	assertEvent(t, events[0], "take", "Alice", posts[0])
	assertEvent(t, events[1], "post", "Alice", posts[0])
}

func TestPatternTakeWaitsForOldestLockedEntry(t *testing.T) {
	f := newAPIFixture(t)
	_, token := f.token(t, "demo", "Alice", "post,read,take")
	oldest := f.post(t, token, "old", `{"kind":"work"}`)
	newer := f.post(t, token, "new", `{"kind":"work"}`)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Simulate a database transaction that locks the oldest row and then rolls back.
	lock, err := f.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lock.Rollback(context.Background()) }()
	if _, err := lock.Exec(ctx, "SELECT id FROM entries WHERE id::text = $1 FOR UPDATE", oldest.ID); err != nil {
		t.Fatal(err)
	}
	pending := make(chan apiResponse, 1)
	go func() {
		pending <- f.request(ctx, "POST", "demo/take", token, "claim", `{"pattern":{"kind":"work"},"waitMs":2500}`)
	}()
	select {
	case result := <-pending:
		t.Fatalf("take skipped the oldest locked entry: %+v", result)
	case <-time.After(350 * time.Millisecond):
	}
	if err := lock.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var taken observedEntry
	(<-pending).want(t, 200, &taken)
	if taken.ID != oldest.ID {
		t.Fatalf("take claimed %s, want oldest entry %s", taken.ID, oldest.ID)
	}
	assertEntries(t, f.browse(t, token, `{}`), newer.ID)
}

func TestServeOptionalBuiltUIAlongsideHeadlessAPI(t *testing.T) {
	f := newAPIFixture(t)
	_, token := f.token(t, "demo", "Alice", "read")
	assets := map[string]string{
		"/":                  "<!doctype html><title>Whiteboard</title>",
		"/assets/app.js":     "export const ready = true;",
		"/assets/styles.css": "html { color: black; }",
	}
	request := func(path string, status int, content string) {
		t.Helper()
		response, err := f.server.Client().Get(f.server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != status || (content != "" && string(body) != content) {
			t.Fatalf("GET %s: wanted %d %q, got %d %q (%v)", path, status, content, response.StatusCode, body, err)
		}
	}
	request("/", 404, "")
	f.call(t, "GET", "demo", token, "", "", 200, nil)

	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "assets"), 0755); err != nil {
		t.Fatal(err)
	}
	for path, content := range assets {
		if path == "/" {
			path = "/index.html"
		}
		if err := os.WriteFile(filepath.Join(dir, path), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	f.start(t, dir)
	for path, content := range assets {
		request(path, 200, content)
	}
	request("/boards/demo", 200, assets["/"])
	request("/assets/does-not-exist", 404, "")
	f.call(t, "GET", "demo/", token, "", "", 200, nil)
}
