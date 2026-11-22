package main

import (
	"context"
	"fmt"
	"strconv"
	"testing"
	"time"
)

func TestEntryDeadlinePreservesActivityAndIdempotency(t *testing.T) {
	f := newAPIFixture(t)
	_, token := f.token(t, "demo", "Maintainer", "read,post,take")
	const payload = `{"kind":"work","task":"timed","exact":9007199254740993,"expiresAt":"workflow data"}`
	postBody := func(deadline string) string {
		return fmt.Sprintf(`{"payload":%s,"expiresAt":%q}`, payload, deadline)
	}
	f.call(t, "POST", "demo/entries", token, "invalid", postBody("tomorrow"), 400, nil)
	var expired, replay entry
	f.call(t, "POST", "demo/entries", token, "deadline", postBody("2000-01-01T12:00:00+02:00"), 201, &expired)
	if !expired.Expired || expired.ExpiresAt.Format(time.RFC3339Nano) != "2000-01-01T10:00:00Z" {
		t.Fatalf("unexpected deadline metadata: %+v", expired)
	}
	f.call(t, "POST", "demo/entries", token, "deadline", postBody("2000-01-01T10:00:00Z"), 201, &replay)
	if replay.ID != expired.ID || !replay.ExpiresAt.Equal(*expired.ExpiresAt) {
		t.Fatalf("retry changed the entry or deadline: %+v", replay)
	}
	f.call(t, "POST", "demo/entries", token, "deadline", postBody("2000-01-02T10:00:00Z"), 409, nil)
	f.call(t, "POST", "demo/read", token, "", `{"pattern":{}}`, 204, nil)
	f.call(t, "POST", "demo/take", token, "pattern", `{"pattern":{}}`, 204, nil)
	assertEntries(t, f.browse(t, token, `{}`))
	var conflict apiError
	f.call(t, "POST", "demo/take", token, "exact", `{"entryId":"`+expired.ID+`"}`, 409, &conflict)
	if conflict.Code != "entry_expired" {
		t.Fatalf("exact take returned %s, want entry_expired", conflict.Code)
	}
	var detail entry
	f.call(t, "GET", "demo/entries/"+expired.ID, token, "", "", 200, &detail)
	if !detail.Expired || string(detail.Payload) != payload {
		t.Fatalf("expired JSON unavailable or changed: %+v", detail)
	}
	for _, query := range []string{"", "?summary=1"} {
		var history struct{ Events []event }
		f.call(t, "GET", "demo/history"+query, token, "", "", 200, &history)
		if len(history.Events) != 1 || !history.Events[0].Entry.Expired {
			t.Fatalf("expiry should leave one Post in history, got %+v", history)
		}
	}
}

func TestDeadlinePassesWhileBoardIsArchived(t *testing.T) {
	f := newAPIFixture(t)
	_, token := f.token(t, "demo", "Maintainer", "read,post,take")
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	var deadline time.Time
	if err := f.db.QueryRow(ctx, "SELECT clock_timestamp() + interval '2 seconds'").Scan(&deadline); err != nil {
		t.Fatal(err)
	}
	var original, replacement entry
	f.call(t, "POST", "demo/entries", token, "post",
		fmt.Sprintf(`{"payload":{"kind":"work"},"expiresAt":%q}`, deadline.Format(time.RFC3339Nano)), 201, &original)
	takeInput := `{"entryId":"` + original.ID + `"}`
	f.call(t, "POST", "demo/take", token, "take", takeInput, 200, nil)
	repost := "demo/entries/" + original.ID + "/repost"
	f.call(t, "POST", repost, token, "repost", `{}`, 201, &replacement)
	if replacement.Expired || !replacement.ExpiresAt.Equal(*original.ExpiresAt) {
		t.Fatalf("repost changed the availability window: %+v", replacement)
	}
	f.operator(t, "board", "archive", "demo")
	if _, err := f.db.Exec(ctx, "SELECT pg_sleep_until($1)", deadline); err != nil {
		t.Fatal(err)
	}
	f.operator(t, "board", "reopen", "demo")
	assertEntries(t, f.browse(t, token, `{}`))
	f.call(t, "GET", "demo/entries/"+replacement.ID, token, "", "", 200, &replacement)
	if !replacement.Expired {
		t.Fatal("reopening revived an expired entry")
	}
	var replay entry
	f.call(t, "POST", "demo/take", token, "take", takeInput, 200, &replay)
	if replay.ID != original.ID || replay.Expired {
		t.Fatalf("deadline changed a committed Take: %+v", replay)
	}
	var conflict apiError
	f.call(t, "POST", repost, token, "another-repost", `{}`, 409, &conflict)
	if conflict.Code != "entry_expired" {
		t.Fatalf("repost after deadline returned %s, want entry_expired", conflict.Code)
	}
}

func TestPatternTakeSkipsEntryThatExpiresWhileWaitingForItsLock(t *testing.T) {
	f := newAPIFixture(t)
	_, token := f.token(t, "demo", "Maintainer", "read,post,take")
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	var deadline time.Time
	if err := f.db.QueryRow(ctx, "SELECT clock_timestamp() + interval '2 seconds'").Scan(&deadline); err != nil {
		t.Fatal(err)
	}
	var first entry
	f.call(t, "POST", "demo/entries", token, "earliest",
		fmt.Sprintf(`{"payload":{"kind":"work"},"expiresAt":%q}`, deadline.Format(time.RFC3339Nano)), 201, &first)
	next := f.post(t, token, "next", `{"kind":"work"}`)
	firstID, err := strconv.ParseInt(first.ID, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := f.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	var locker int32
	if err := tx.QueryRow(ctx, "SELECT pg_backend_pid() FROM entries WHERE id = $1 FOR UPDATE", firstID).Scan(&locker); err != nil {
		t.Fatal(err)
	}
	pending := make(chan apiResponse, 1)
	go func() {
		pending <- f.request(ctx, "POST", "demo/take", token, "pattern", `{"pattern":{"kind":"work"}}`)
	}()
	f.waitForBlockedRequest(t, ctx, locker)
	if _, err := tx.Exec(ctx, "SELECT pg_sleep_until($1)", deadline); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var claimed entry
	(<-pending).want(t, 200, &claimed)
	if claimed.ID != next.ID {
		t.Fatalf("Take claimed %s, want next eligible entry %s", claimed.ID, next.ID)
	}
}
