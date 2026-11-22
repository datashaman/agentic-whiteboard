package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type entry struct {
	ID        string          `json:"id"`
	Payload   json.RawMessage `json:"payload"`
	PostedAt  time.Time       `json:"postedAt"`
	ExpiresAt *time.Time      `json:"expiresAt,omitempty"`
	Expired   bool            `json:"expired,omitempty"`
}

const expiryFields = "expires_at, (live AND expires_at IS NOT NULL AND expires_at <= statement_timestamp())"
const entryFields = "id::text, payload, posted_at, " + expiryFields
const matchingEntries = "SELECT " + entryFields + matchClause

const filterEntries = `
	FROM entries
	WHERE board = $1 AND live
	AND (expires_at IS NULL OR expires_at > statement_timestamp())
	AND NOT EXISTS (
		SELECT FROM jsonb_each($2::jsonb) AS pattern
		WHERE entries.match_data -> pattern.key IS DISTINCT FROM pattern.value
	)
`

const matchClause = filterEntries + " ORDER BY entries.id "

func scanEntry(row pgx.Row) (entry, error) {
	var result entry
	err := row.Scan(&result.ID, &result.Payload, &result.PostedAt, &result.ExpiresAt, &result.Expired)
	result.normalizeTimes()
	return result, err
}

func (e *entry) normalizeTimes() {
	e.PostedAt = e.PostedAt.UTC()
	if e.ExpiresAt != nil {
		*e.ExpiresAt = e.ExpiresAt.UTC()
	}
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
	cursor, err := pageCursor(r)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	fields, summary := listFields(r)
	rows, err := a.db.Query(r.Context(),
		"SELECT id::text, "+fields+", posted_at, "+expiryFields+filterEntries+" AND id > $3 ORDER BY entries.id LIMIT $4",
		access.ID, pattern, cursor, pageSize+1)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	entries, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (entry, error) {
		result, err := scanEntry(row)
		if err == nil && summary {
			result.Payload, err = decodeSummary(result.Payload)
		}
		return result, err
	})
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	var next string
	if len(entries) > pageSize {
		entries = entries[:pageSize]
		next = entries[pageSize-1].ID
	}
	writeJSON(w, http.StatusOK, struct {
		Entries    []entry `json:"entries"`
		NextCursor string  `json:"nextCursor,omitempty"`
	}{Entries: entries, NextCursor: next})
}

func (a *api) entryDetails(w http.ResponseWriter, r *http.Request, access boardAccess) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 || strconv.FormatInt(id, 10) != r.PathValue("id") {
		writeError(w, http.StatusNotFound, "not_found", "entry not found on this board")
		return
	}
	result, err := scanEntry(a.db.QueryRow(r.Context(),
		"SELECT "+entryFields+" FROM entries WHERE board = $1 AND id = $2", access.ID, id))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "not_found", "entry not found on this board")
		return
	}
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
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
		Payload   json.RawMessage `json:"payload"`
		ExpiresAt *string         `json:"expiresAt"`
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
	inputs := match
	var expiresAt *time.Time
	if input.ExpiresAt != nil {
		at, err := time.Parse(time.RFC3339Nano, *input.ExpiresAt)
		at = at.UTC().Truncate(time.Microsecond)
		if err != nil || at.Year() < 1 || at.Year() > 9999 {
			writeFailure(w, r, invalidRequest("expiresAt must be an RFC 3339 timestamp"))
			return
		}
		expiresAt = &at
		inputs, err = json.Marshal(struct {
			Payload   json.RawMessage `json:"payload"`
			ExpiresAt time.Time       `json:"expiresAt"`
		}{Payload: match, ExpiresAt: at})
		if err != nil {
			writeFailure(w, r, err)
			return
		}
	}
	result, err := a.mutate(r.Context(), r.Context(), access, key, "post", inputs, func(ctx context.Context, tx pgx.Tx) (entry, error) {
		return scanEntry(tx.QueryRow(ctx, `
			INSERT INTO entries (board, payload, match_data, expires_at) VALUES ($1, $2, $3, $4)
			RETURNING `+entryFields, access.ID, input.Payload, match, expiresAt))
	})
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (a *api) repost(w http.ResponseWriter, r *http.Request, access boardAccess) {
	if !slices.Contains(access.Permissions, "post") {
		writeError(w, http.StatusForbidden, "forbidden", "post permission is required")
		return
	}
	key, err := requestKey(r)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	if _, err := decodeRequest[struct{}](w, r); err != nil {
		writeFailure(w, r, err)
		return
	}
	notFound := &apiError{http.StatusNotFound, "not_found", "taken entry not found on this board"}
	source := r.PathValue("id")
	id, err := strconv.ParseInt(source, 10, 64)
	if err != nil || id < 1 || strconv.FormatInt(id, 10) != source {
		writeFailure(w, r, notFound)
		return
	}

	// Repost inputs have their own shape in the idempotency log. The event
	// remains a Post so existing history clients see the new entry as usual.
	inputs := json.RawMessage(`{"repost":` + strconv.Quote(source) + `}`)
	result, err := a.mutate(r.Context(), r.Context(), access, key, "post", inputs, func(ctx context.Context, tx pgx.Tx) (entry, error) {
		result, err := scanEntry(tx.QueryRow(ctx, `
			INSERT INTO entries (board, payload, match_data, reposted_from, expires_at)
			SELECT board, payload, match_data, id, expires_at FROM entries
			WHERE board = $1 AND id = $2 AND NOT live
			RETURNING `+entryFields, access.ID, id))
		if err == nil && result.Expired {
			return entry{}, entryExpired
		}
		return result, err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		err = notFound
	}
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
		SELECT ev.operation = $4 AND ev.inputs = $5::jsonb, en.id::text, en.payload, en.posted_at, `+expiryFields+`
		FROM events ev JOIN entries en ON en.board = ev.board AND en.id = ev.entry_id
		WHERE ev.board = $1 AND ev.token_id = $2 AND ev.request_key = $3
	`, access.ID, access.tokenID, key[:], operation, inputs).
		Scan(&sameInputs, &result.ID, &result.Payload, &result.PostedAt, &result.ExpiresAt, &result.Expired)
	switch {
	case err == nil:
		if !sameInputs {
			return entry{}, &apiError{http.StatusConflict, "request_conflict", "this request ID already has a different outcome"}
		}
		result.normalizeTimes()
	case errors.Is(err, pgx.ErrNoRows):
		// Hold a shared lock until commit so archiving waits for mutations already in progress.
		if err := access.checkArchive(tx.QueryRow(ctx, boardState+" FOR SHARE", access.ID)); err != nil {
			return entry{}, err
		}
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
			return takePattern(ctx, tx, access.ID, pattern)
		})
	})
	if wait > 0 && errors.Is(err, pgx.ErrNoRows) {
		if archiveErr := access.checkArchive(a.db.QueryRow(r.Context(), boardState, access.ID)); archiveErr != nil {
			err = archiveErr
		}
	}
	writeLookup(w, r, result, err)
}

var entryExpired = &apiError{http.StatusConflict, "entry_expired", "This entry's availability deadline has passed."}

func takePattern(ctx context.Context, tx pgx.Tx, board string, pattern json.RawMessage) (entry, error) {
	for {
		// Waiting on the first candidate preserves order if a concurrent take rolls back.
		var id int64
		err := tx.QueryRow(ctx, "SELECT id "+matchClause+"LIMIT 1 FOR UPDATE", board, pattern).Scan(&id)
		if err != nil {
			return entry{}, err
		}
		result, err := claimLockedEntry(ctx, tx, board, id)
		if !errors.Is(err, pgx.ErrNoRows) {
			return result, err
		}
		// The first candidate expired while waiting for its lock. Look for the next match.
	}
}

func takeExact(ctx context.Context, tx pgx.Tx, board, entryID string) (entry, error) {
	notFound := &apiError{http.StatusNotFound, "not_found", "entry not found on this board"}
	id, err := strconv.ParseInt(entryID, 10, 64)
	if err != nil || id < 1 || strconv.FormatInt(id, 10) != entryID {
		return entry{}, notFound
	}
	var live bool
	err = tx.QueryRow(ctx, "SELECT live FROM entries WHERE board = $1 AND id = $2 FOR UPDATE", board, id).Scan(&live)
	if errors.Is(err, pgx.ErrNoRows) {
		return entry{}, notFound
	}
	if err != nil {
		return entry{}, err
	}
	if !live {
		return entry{}, &apiError{http.StatusConflict, "already_taken", "this entry has already been taken"}
	}
	result, err := claimLockedEntry(ctx, tx, board, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return entry{}, entryExpired
	}
	return result, err
}

func claimLockedEntry(ctx context.Context, tx pgx.Tx, board string, id int64) (entry, error) {
	return scanEntry(tx.QueryRow(ctx, `
		UPDATE entries SET live = false WHERE board = $1 AND id = $2
		AND (expires_at IS NULL OR expires_at > clock_timestamp())
		RETURNING `+entryFields, board, id))
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
	delay := 50 * time.Millisecond
	for waitCtx.Err() == nil {
		attemptCtx, cancel := context.WithTimeout(waitCtx, 250*time.Millisecond)
		result, err := attempt(attemptCtx)
		shortTimeout := errors.Is(attemptCtx.Err(), context.DeadlineExceeded) && errors.Is(err, context.DeadlineExceeded)
		cancel()
		if !errors.Is(err, pgx.ErrNoRows) && !shortTimeout {
			return result, err
		}
		deadline, _ := waitCtx.Deadline()
		remaining := time.Until(deadline)
		if remaining <= 25*time.Millisecond {
			<-waitCtx.Done()
			break
		}
		// Leave time for one last check before the wait budget expires.
		timer := time.NewTimer(min(delay, remaining-25*time.Millisecond))
		select {
		case <-waitCtx.Done():
			timer.Stop()
		case <-timer.C:
		}
		delay = min(delay*2, 500*time.Millisecond)
	}
	if err := ctx.Err(); err != nil {
		return entry{}, err
	}
	return entry{}, pgx.ErrNoRows
}
