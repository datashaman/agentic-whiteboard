package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type entry struct {
	ID       string          `json:"id"`
	Payload  json.RawMessage `json:"payload"`
	PostedAt time.Time       `json:"postedAt"`
}

const matchingEntries = "SELECT id::text, payload, posted_at " + matchClause

const matchClause = `
	FROM entries
	WHERE board = $1 AND live AND NOT EXISTS (
		SELECT FROM jsonb_each($2::jsonb) AS pattern
		WHERE entries.match_data -> pattern.key IS DISTINCT FROM pattern.value
	)
	ORDER BY id
`

func scanEntry(row pgx.Row) (entry, error) {
	var result entry
	err := row.Scan(&result.ID, &result.Payload, &result.PostedAt)
	result.PostedAt = result.PostedAt.UTC()
	return result, err
}

func (a *api) browse(w http.ResponseWriter, r *http.Request, access boardAccess) {
	input, err := decodeRequest[struct {
		Pattern json.RawMessage `json:"pattern"`
	}](w, r)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	pattern, err := canonicalPattern(input.Pattern)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	rows, err := a.db.Query(r.Context(), matchingEntries, access.ID, pattern)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	entries, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (entry, error) { return scanEntry(row) })
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Entries []entry `json:"entries"`
	}{Entries: entries})
}

func canonicalPattern(pattern json.RawMessage) (json.RawMessage, error) {
	if pattern == nil {
		return json.RawMessage("{}"), nil
	}
	return canonicalObject(pattern, "pattern")
}

func (a *api) post(w http.ResponseWriter, r *http.Request, access boardAccess) {
	key, err := requestKey(r)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	input, err := decodeRequest[struct {
		Payload json.RawMessage `json:"payload"`
	}](w, r)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	match, err := canonicalObject(input.Payload, "payload")
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	result, err := a.mutate(r.Context(), r.Context(), access, key, "post", match, func(ctx context.Context, tx pgx.Tx) (entry, error) {
		return scanEntry(tx.QueryRow(ctx, `
			INSERT INTO entries (board, payload, match_data) VALUES ($1, $2, $3)
			RETURNING id::text, payload, posted_at
		`, access.ID, input.Payload, match))
	})
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func requestKey(r *http.Request) ([32]byte, error) {
	keys := r.Header.Values("Idempotency-Key")
	if len(keys) != 1 || strings.TrimSpace(keys[0]) == "" {
		return [32]byte{}, invalidRequest("provide one nonempty Idempotency-Key header")
	}
	return sha256.Sum256([]byte(keys[0])), nil
}

func (a *api) mutate(
	requestCtx, ctx context.Context, access boardAccess, key [32]byte, operation string, inputs json.RawMessage,
	change func(context.Context, pgx.Tx) (entry, error),
) (entry, error) {
	tx, err := a.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return entry{}, err
	}
	defer func() { _ = tx.Rollback(requestCtx) }()

	var activeID int64
	err = tx.QueryRow(ctx, `
		SELECT id FROM tokens WHERE board = $1 AND id = $2 AND revoked_at IS NULL FOR SHARE
	`, access.ID, access.tokenID).Scan(&activeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return entry{}, unauthorized
	}
	if err != nil {
		return entry{}, err
	}

	// Concurrent uses of the same key must see the committed outcome before selecting an entry.
	if _, err := tx.Exec(ctx, `
		SELECT pg_advisory_xact_lock(hashtextextended(encode($1::bytea, 'hex'), $2))
	`, key[:], access.tokenID); err != nil {
		return entry{}, err
	}
	var result entry
	var sameInputs bool
	err = tx.QueryRow(ctx, `
		SELECT ev.operation = $4 AND ev.inputs = $5::jsonb, en.id::text, en.payload, en.posted_at
		FROM events ev JOIN entries en ON en.board = ev.board AND en.id = ev.entry_id
		WHERE ev.board = $1 AND ev.token_id = $2 AND ev.request_key = $3
	`, access.ID, access.tokenID, key[:], operation, inputs).
		Scan(&sameInputs, &result.ID, &result.Payload, &result.PostedAt)
	switch {
	case err == nil:
		if !sameInputs {
			return entry{}, &apiError{http.StatusConflict, "request_conflict", "this request ID already has a different outcome"}
		}
		result.PostedAt = result.PostedAt.UTC()
	case errors.Is(err, pgx.ErrNoRows):
		result, err = change(ctx, tx)
		if err != nil {
			return entry{}, err
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO events (board, token_id, entry_id, operation, request_key, inputs)
			VALUES ($1, $2, $3::text::bigint, $4, $5, $6)
		`, access.ID, access.tokenID, result.ID, operation, key[:], inputs)
		if err != nil {
			return entry{}, err
		}
	default:
		return entry{}, err
	}

	// Once an attempt has recorded an outcome, commit under the HTTP request's lifetime.
	return result, tx.Commit(requestCtx)
}

func (a *api) read(w http.ResponseWriter, r *http.Request, access boardAccess) {
	input, err := decodeRequest[struct {
		Pattern json.RawMessage `json:"pattern"`
		WaitMs  json.RawMessage `json:"waitMs"`
	}](w, r)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	pattern, err := canonicalPattern(input.Pattern)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	wait, err := parseWait(input.WaitMs)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	result, err := waitForEntry(r.Context(), wait, func(ctx context.Context) (entry, error) {
		if wait > 0 {
			if _, err := a.authenticate(ctx, access.ID, r.Header.Get("Authorization")); err != nil {
				return entry{}, err
			}
		}
		return scanEntry(a.db.QueryRow(ctx, matchingEntries+"LIMIT 1", access.ID, pattern))
	})
	writeLookup(w, r, result, err)
}

func writeLookup(w http.ResponseWriter, r *http.Request, result entry, err error) {
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		w.WriteHeader(http.StatusNoContent)
	case err != nil:
		writeFailure(w, r, err)
	default:
		writeJSON(w, http.StatusOK, result)
	}
}

func (a *api) take(w http.ResponseWriter, r *http.Request, access boardAccess) {
	key, err := requestKey(r)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	input, err := decodeRequest[struct {
		Pattern json.RawMessage `json:"pattern"`
		EntryID json.RawMessage `json:"entryId"`
		WaitMs  json.RawMessage `json:"waitMs"`
	}](w, r)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	if (input.Pattern == nil) == (input.EntryID == nil) {
		writeFailure(w, r, invalidRequest("provide exactly one of pattern and entryId"))
		return
	}

	wait, err := parseWait(input.WaitMs)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	var entryID string
	var pattern json.RawMessage
	if input.EntryID != nil {
		if err := json.Unmarshal(input.EntryID, &entryID); err != nil || entryID == "" {
			writeFailure(w, r, invalidRequest("entryId must be a nonempty string"))
			return
		}
	} else {
		pattern, err = canonicalObject(input.Pattern, "pattern")
		if err != nil {
			writeFailure(w, r, err)
			return
		}
	}
	inputs := struct {
		Pattern json.RawMessage `json:"pattern,omitempty"`
		EntryID string          `json:"entryId,omitempty"`
		WaitMs  int64           `json:"waitMs"`
	}{Pattern: pattern, WaitMs: wait.Milliseconds()}
	if entryID != "" {
		inputs.EntryID = strconv.Quote(entryID)
		wait = 0
	}
	replayInputs, err := json.Marshal(inputs)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	result, err := waitForEntry(r.Context(), wait, func(ctx context.Context) (entry, error) {
		return a.mutate(r.Context(), ctx, access, key, "take", replayInputs, func(ctx context.Context, tx pgx.Tx) (entry, error) {
			if entryID != "" {
				return takeExact(ctx, tx, access.ID, entryID)
			}
			// Waiting on the first candidate preserves order if a concurrent take rolls back.
			return scanEntry(tx.QueryRow(ctx, `
				WITH candidate AS (SELECT id `+matchClause+` LIMIT 1 FOR UPDATE)
				UPDATE entries en SET live = false FROM candidate
				WHERE en.board = $1 AND en.id = candidate.id
				RETURNING en.id::text, en.payload, en.posted_at
			`, access.ID, pattern))
		})
	})
	writeLookup(w, r, result, err)
}

func takeExact(ctx context.Context, tx pgx.Tx, board, entryID string) (entry, error) {
	notFound := &apiError{http.StatusNotFound, "not_found", "entry not found on this board"}
	id, err := strconv.ParseInt(entryID, 10, 64)
	if err != nil || id < 1 || strconv.FormatInt(id, 10) != entryID {
		return entry{}, notFound
	}
	result, err := scanEntry(tx.QueryRow(ctx, `
		UPDATE entries SET live = false WHERE board = $1 AND id = $2 AND live
		RETURNING id::text, payload, posted_at
	`, board, id))
	if !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	var exists bool
	err = tx.QueryRow(ctx, "SELECT EXISTS (SELECT FROM entries WHERE board = $1 AND id = $2)", board, id).Scan(&exists)
	if err != nil {
		return entry{}, err
	}
	if !exists {
		return entry{}, notFound
	}
	return entry{}, &apiError{http.StatusConflict, "already_taken", "this entry has already been taken"}
}

func parseWait(raw json.RawMessage) (time.Duration, error) {
	if raw == nil {
		return 0, nil
	}
	milliseconds, err := strconv.Atoi(string(raw))
	if err != nil || milliseconds < 0 || milliseconds > 30000 {
		return 0, invalidRequest("waitMs must be an integer from 0 through 30000")
	}
	return time.Duration(milliseconds) * time.Millisecond, nil
}

func waitForEntry(ctx context.Context, wait time.Duration, attempt func(context.Context) (entry, error)) (entry, error) {
	if wait == 0 {
		return attempt(ctx)
	}
	waitCtx, stop := context.WithTimeout(ctx, wait)
	defer stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()

	for waitCtx.Err() == nil {
		attemptCtx, cancel := context.WithTimeout(waitCtx, 250*time.Millisecond)
		result, err := attempt(attemptCtx)
		shortTimeout := errors.Is(attemptCtx.Err(), context.DeadlineExceeded) && errors.Is(err, context.DeadlineExceeded)
		cancel()
		if !errors.Is(err, pgx.ErrNoRows) && !shortTimeout {
			return result, err
		}
		select {
		case <-waitCtx.Done():
		case <-ticker.C:
		}
	}
	if err := ctx.Err(); err != nil {
		return entry{}, err
	}
	return entry{}, pgx.ErrNoRows
}
