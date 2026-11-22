package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

const pageSize = 50

func pageCursor(r *http.Request) (int64, error) {
	cursor := r.URL.Query().Get("cursor")
	if cursor == "" {
		return 0, nil
	}
	id, err := strconv.ParseInt(cursor, 10, 64)
	if err != nil || id < 1 || strconv.FormatInt(id, 10) != cursor {
		return 0, invalidRequest("cursor must be a positive entry or event ID")
	}
	return id, nil
}

// match_data holds quoted strings and exact, normalized numbers. Project from
// it so legal JSON such as a NUL escape or an enormous exponent still works.
const summaryFields = `(
	SELECT coalesce(jsonb_object_agg(field, value), '{}'::jsonb)
	FROM unnest(ARRAY['kind', 'task', 'issue', 'title', 'sourceEntryId']) AS field
	CROSS JOIN LATERAL (SELECT match_data -> ('"' || field || '"') AS value) AS selected
	WHERE jsonb_typeof(value) = 'string'
)`

func listFields(r *http.Request) (string, bool) {
	if r.URL.Query().Get("summary") == "1" {
		return summaryFields, true
	}
	return "payload", false
}

func decodeSummary(data json.RawMessage) (json.RawMessage, error) {
	var fields map[string]string
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil, err
	}
	result := make(map[string]any, len(fields))
	for field, value := range fields {
		if strings.HasPrefix(value, `"`) {
			text, err := strconv.Unquote(value)
			if err != nil {
				return nil, err
			}
			if field == "title" {
				chars := []rune(text)
				if len(chars) > 160 {
					text = string(chars[:159]) + "…"
				}
			}
			result[field] = text
		} else if field == "issue" {
			result[field] = json.Number(value)
		}
	}
	return json.Marshal(result)
}

func (a *api) overview(w http.ResponseWriter, r *http.Request, access boardAccess) {
	ctx := r.Context()
	rows, err := a.db.Query(ctx, `
		SELECT DISTINCT match_data ->> '"issue"'
		FROM entries
		WHERE board = $1 AND jsonb_typeof(match_data -> '"issue"') = 'string'
	`, access.ID)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	values, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	issues := make([]any, 0, len(values))
	for _, value := range values {
		if strings.HasPrefix(value, `"`) {
			text, err := strconv.Unquote(value)
			if err != nil {
				writeFailure(w, r, err)
				return
			}
			issues = append(issues, text)
		} else {
			issues = append(issues, json.Number(value))
		}
	}
	// The Tasks view needs older work and results to derive status accurately.
	// Other views need only the work identities used for issue attribution.
	tasks := r.URL.Query().Get("tasks") == "1"
	fields := summaryFields
	if !tasks {
		fields = `jsonb_strip_nulls(jsonb_build_object(
			'kind', match_data -> '"kind"', 'task', match_data -> '"task"',
			'issue', CASE WHEN jsonb_typeof(match_data -> '"issue"') = 'string' THEN match_data -> '"issue"' END))`
	}
	rows, err = a.db.Query(ctx, eventQuery(fields)+`
		WHERE ev.board = $1 AND left(match_data ->> '"task"', 1) = '"'
			AND (
				match_data ->> '"kind"' = '"work"' AND ($2 OR ev.operation = 'post')
				OR $2 AND match_data ->> '"kind"' = '"result"' AND ev.operation = 'post'
			)
		ORDER BY ev.at DESC, ev.id DESC
	`, access.ID, tasks)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	events, err := collectEvents(rows, true)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Issues []any   `json:"issues"`
		Events []event `json:"events"`
	}{Issues: issues, Events: events})
}
