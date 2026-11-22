package main

import (
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

type event struct {
	ID           string    `json:"id"`
	Operation    string    `json:"operation"`
	Actor        string    `json:"actor"`
	At           time.Time `json:"at"`
	Entry        entry     `json:"entry"`
	RepostedFrom *string   `json:"repostedFrom,omitempty"`
	LatestRepost *string   `json:"latestRepost,omitempty"`
}

func eventQuery(fields string, includeReposts bool) string {
	reposts := ", NULL::text, NULL::text"
	if includeReposts {
		reposts = `, CASE WHEN ev.operation = 'post' THEN en.reposted_from::text END,
			CASE WHEN ev.operation = 'take' THEN (
				SELECT child.id::text FROM entries child
				WHERE child.board = en.board AND child.reposted_from = en.id
				ORDER BY child.id DESC LIMIT 1
			) END`
	}
	return "SELECT ev.id::text, ev.operation, t.actor, ev.at, en.id::text, " + fields + ", en.posted_at, " + expiryFields + reposts + `
		FROM events ev
		JOIN tokens t ON t.board = ev.board AND t.id = ev.token_id
		JOIN entries en ON en.board = ev.board AND en.id = ev.entry_id
	`
}

func collectEvents(rows pgx.Rows, summary bool) ([]event, error) {
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (event, error) {
		var result event
		err := row.Scan(&result.ID, &result.Operation, &result.Actor, &result.At,
			&result.Entry.ID, &result.Entry.Payload, &result.Entry.PostedAt, &result.Entry.ExpiresAt,
			&result.Entry.Expired, &result.RepostedFrom, &result.LatestRepost)
		result.At = result.At.UTC()
		result.Entry.normalizeTimes()
		if err == nil && summary {
			result.Entry.Payload, err = decodeSummary(result.Entry.Payload)
		}
		return result, err
	})
}

func (a *api) history(w http.ResponseWriter, r *http.Request, access boardAccess) {
	cursor, err := pageCursor(r)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	var id int64
	if value := r.URL.Query().Get("entryId"); value != "" {
		id, err = strconv.ParseInt(value, 10, 64)
		if err != nil || id < 1 || strconv.FormatInt(id, 10) != value {
			writeFailure(w, r, invalidRequest("entryId must be a positive entry ID"))
			return
		}
	}
	fields, summary := listFields(r)
	rows, err := a.db.Query(r.Context(), eventQuery(fields, true)+`
		WHERE ev.board = $1 AND ($2 = 0 OR (ev.at, ev.id) < (
			SELECT at, id FROM events WHERE board = $1 AND id = $2
		)) AND ($3 = 0 OR ev.entry_id = $3)
		ORDER BY ev.at DESC, ev.id DESC LIMIT $4
	`, access.ID, cursor, id, pageSize+1)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	events, err := collectEvents(rows, summary)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	var next string
	if len(events) > pageSize {
		events = events[:pageSize]
		next = events[pageSize-1].ID
	}
	writeJSON(w, http.StatusOK, struct {
		Events     []event `json:"events"`
		NextCursor string  `json:"nextCursor,omitempty"`
	}{Events: events, NextCursor: next})
}
