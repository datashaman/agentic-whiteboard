package main

import (
	"context"
	"crypto/sha256"
	"strconv"
	"testing"
	"time"
)

func TestArchivePreservesReadsAndRecoveryWhilePausingMutations(t *testing.T) {
	f := newAPIFixture(t)
	_, token := f.token(t, "demo", "Maintainer", "post,read,take")
	taken := f.post(t, token, "draft", `{"kind":"work","task":"draft"}`)
	exactTake := `{"entryId":"` + taken.ID + `"}`
	f.call(t, "POST", "demo/take", token, "take-draft", exactTake, 200, nil)
	live := f.post(t, token, "live", `{"kind":"work","task":"live"}`)
	repostRoute := "demo/entries/" + taken.ID + "/repost"

	f.operator(t, "board", "archive", "demo")
	f.operator(t, "board", "archive", "demo")
	var board boardAccess
	f.call(t, "GET", "demo", token, "", "", 200, &board)
	if !board.Archived {
		t.Fatal("board details should report archived")
	}
	for _, request := range []struct{ path, body string }{
		{"demo/entries", `{"payload":{}}`},
		{"demo/take", `{"entryId":"` + live.ID + `"}`},
		{"demo/take", `{"pattern":{"kind":"work"},"waitMs":30000}`},
		{repostRoute, `{}`},
	} {
		var response apiError
		f.call(t, "POST", request.path, token, "new-mutation", request.body, 409, &response)
		if response.Code != "board_archived" {
			t.Fatalf("%s returned %q, want board_archived", request.path, response.Code)
		}
	}
	assertEntries(t, f.browse(t, token, `{}`), live.ID)
	var read observedEntry
	f.call(t, "POST", "demo/read", token, "", `{"pattern":{}}`, 200, &read)
	if read.ID != live.ID {
		t.Fatalf("read returned %s, want %s", read.ID, live.ID)
	}
	f.call(t, "GET", "demo/entries/"+taken.ID, token, "", "", 200, &read)
	if read.ID != taken.ID {
		t.Fatalf("entry details returned %s, want %s", read.ID, taken.ID)
	}
	var replay observedEntry
	f.call(t, "POST", "demo/take", token, "take-draft", exactTake, 200, &replay)
	if replay.ID != taken.ID || len(f.history(t, token)) != 3 {
		t.Fatal("an archived board should replay the committed Take without creating an event")
	}

	f.operator(t, "board", "reopen", "demo")
	f.call(t, "GET", "demo", token, "", "", 200, &board)
	if board.Archived {
		t.Fatal("board details should report reopened")
	}
	assertEntries(t, f.browse(t, token, `{}`), live.ID)
	var conflict apiError
	f.call(t, "POST", "demo/take", token, "take-again", exactTake, 409, &conflict)
	if conflict.Code != "already_taken" {
		t.Fatalf("reopen changed the original Take: %s", conflict.Code)
	}
	var recovered observedEntry
	f.call(t, "POST", repostRoute, token, "new-mutation", `{}`, 201, &recovered)
	if recovered.ID == taken.ID || string(recovered.Payload) != string(taken.Payload) {
		t.Fatalf("reopen did not preserve recovery: %+v", recovered)
	}
	assertEntries(t, f.browse(t, token, `{}`), live.ID, recovered.ID)
}

func TestWaitingTakeObservesArchiveEvenAfterQuickReopen(t *testing.T) {
	f := newAPIFixture(t)
	tokenID, token := f.token(t, "demo", "Worker", "take")
	id, err := strconv.ParseInt(tokenID, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	tx, err := f.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	// Hold the request lock until the handler has authenticated and the board has reopened.
	const key = "waiting-take"
	digest := sha256.Sum256([]byte(key))
	var locker int32
	err = tx.QueryRow(ctx, `
		SELECT pg_backend_pid(), pg_advisory_xact_lock(hashtextextended(encode($1::bytea, 'hex'), $2))
	`, digest[:], id).Scan(&locker, nil)
	if err != nil {
		t.Fatal(err)
	}
	pending := make(chan apiResponse, 1)
	go func() {
		pending <- f.request(ctx, "POST", "demo/take", token, key, `{"pattern":{},"waitMs":30000}`)
	}()
	f.waitForBlockedRequest(t, ctx, locker)
	f.operator(t, "board", "archive", "demo")
	f.operator(t, "board", "reopen", "demo")
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var response apiError
	(<-pending).want(t, 409, &response)
	if response.Code != "board_archived" {
		t.Fatalf("waiting Take returned %q, want board_archived", response.Code)
	}
}

func (f *apiFixture) waitForBlockedRequest(t *testing.T, ctx context.Context, locker int32) {
	t.Helper()
	for {
		var blocked bool
		err := f.db.QueryRow(ctx, `
			SELECT EXISTS (SELECT FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)))
		`, locker).Scan(&blocked)
		if err != nil {
			t.Fatalf("waiting request never reached its lock: %v", err)
		}
		if blocked {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}
