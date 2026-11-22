package main

import (
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

type event struct {
	ID        string    `json:"id"`
	Operation string    `json:"operation"`
	Actor     string    `json:"actor"`
	At        time.Time `json:"at"`
	Entry     entry     `json:"entry"`
}

func (a *api) history(w http.ResponseWriter, r *http.Request, access boardAccess) {
	rows, err := a.db.Query(r.Context(), `
		SELECT ev.id::text, ev.operation, t.actor, ev.at, en.id::text, en.payload, en.posted_at
		FROM events ev
		JOIN tokens t ON t.board = ev.board AND t.id = ev.token_id
		JOIN entries en ON en.board = ev.board AND en.id = ev.entry_id
		WHERE ev.board = $1 ORDER BY ev.at DESC, ev.id DESC
	`, access.ID)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	events, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (event, error) {
		var result event
		err := row.Scan(&result.ID, &result.Operation, &result.Actor, &result.At,
			&result.Entry.ID, &result.Entry.Payload, &result.Entry.PostedAt)
		result.At = result.At.UTC()
		result.Entry.PostedAt = result.Entry.PostedAt.UTC()
		return result, err
	})
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Events []event `json:"events"`
	}{Events: events})
}
