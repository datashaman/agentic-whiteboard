package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"path/filepath"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type boardAccess struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	Actor             string   `json:"actor"`
	Permissions       []string `json:"permissions"`
	Archived          bool     `json:"archived"`
	tokenID           int64
	archiveGeneration int64
}

type api struct {
	db *pgxpool.Pool
}

func newHandler(db *pgxpool.Pool, webDir string, creation *boardCreation) http.Handler {
	a := &api{db: db}
	mux := http.NewServeMux()
	if creation != nil {
		create := creation.handler(db)
		mux.HandleFunc("POST /api/boards", create)
		mux.HandleFunc("OPTIONS /api/boards", create)
	}
	mux.HandleFunc("GET /api/boards/{slug}", a.board)
	mux.HandleFunc("GET /api/boards/{slug}/{$}", a.board)
	mux.HandleFunc("POST /api/boards/{slug}/entries", a.withPermission("post", a.post))
	mux.HandleFunc("GET /api/boards/{slug}/entries/{id}", a.withPermission("read", a.entryDetails))
	mux.HandleFunc("POST /api/boards/{slug}/entries/{id}/repost", a.withPermission("read", a.repost))
	mux.HandleFunc("POST /api/boards/{slug}/browse", a.withPermission("read", a.browse))
	mux.HandleFunc("POST /api/boards/{slug}/read", a.withPermission("read", a.read))
	mux.HandleFunc("POST /api/boards/{slug}/take", a.withPermission("take", a.take))
	mux.HandleFunc("GET /api/boards/{slug}/history", a.withPermission("read", a.history))
	mux.HandleFunc("GET /api/boards/{slug}/overview", a.withPermission("read", a.overview))
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "API route not found")
	})
	if webDir != "" {
		serveFile := func(name string) http.HandlerFunc {
			file := filepath.Join(webDir, name)
			return func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, file) }
		}
		index := serveFile("index.html")
		mux.HandleFunc("GET /{$}", index)
		mux.HandleFunc("GET /boards/{slug}", index)
		mux.HandleFunc("GET /boards/{slug}/{$}", index)
		mux.HandleFunc("GET /assets/app.js", serveFile("assets/app.js"))
		mux.HandleFunc("GET /assets/styles.css", serveFile("assets/styles.css"))
	}
	return mux
}

func (a *api) withPermission(permission string, handle func(http.ResponseWriter, *http.Request, boardAccess)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		access, err := a.authenticate(r.Context(), r.PathValue("slug"), r.Header.Get("Authorization"))
		if err != nil {
			writeFailure(w, r, err)
			return
		}
		if !slices.Contains(access.Permissions, permission) {
			writeError(w, http.StatusForbidden, "forbidden", permission+" permission is required")
			return
		}
		handle(w, r, access)
	}
}

func (a *api) board(w http.ResponseWriter, r *http.Request) {
	access, err := a.authenticate(r.Context(), r.PathValue("slug"), r.Header.Get("Authorization"))
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, access)
}

type apiError struct {
	status  int
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *apiError) Error() string { return e.Message }

var unauthorized = &apiError{http.StatusUnauthorized, "unauthorized", "a valid bearer token for this board is required"}

var boardArchived = &apiError{http.StatusConflict, "board_archived", "Board archived. Check its status before retrying."}

const boardState = "SELECT archived, archive_generation FROM boards WHERE slug = $1"

func (access boardAccess) checkArchive(row pgx.Row) error {
	var archived bool
	var generation int64
	if err := row.Scan(&archived, &generation); err != nil {
		return err
	}
	// A waiting Take must observe even an archive followed by a quick reopen.
	if access.Archived || archived || generation != access.archiveGeneration {
		return boardArchived
	}
	return nil
}

func bearerDigest(authorization string) ([32]byte, bool) {
	header := strings.Fields(authorization)
	if len(header) != 2 || !strings.EqualFold(header[0], "Bearer") {
		return [32]byte{}, false
	}
	return sha256.Sum256([]byte(header[1])), true
}

func (a *api) authenticate(ctx context.Context, slug, authorization string) (boardAccess, error) {
	var access boardAccess
	digest, ok := bearerDigest(authorization)
	if !ok {
		return access, unauthorized
	}
	err := a.db.QueryRow(ctx, `
		SELECT b.slug, b.name, t.actor, t.permissions, b.archived, t.id, b.archive_generation
		FROM tokens t JOIN boards b ON b.slug = t.board
		WHERE t.board = $1 AND t.digest = $2 AND t.revoked_at IS NULL
	`, slug, digest[:]).Scan(&access.ID, &access.Name, &access.Actor, &access.Permissions, &access.Archived,
		&access.tokenID, &access.archiveGeneration)
	if errors.Is(err, pgx.ErrNoRows) {
		err = unauthorized
	}
	return access, err
}

func writeFailure(w http.ResponseWriter, r *http.Request, err error) {
	if r.Context().Err() != nil {
		writeError(w, http.StatusServiceUnavailable, "request_interrupted", "request interrupted; retry the request")
		return
	}
	var failure *apiError
	if errors.As(err, &failure) {
		writeError(w, failure.status, failure.Code, failure.Message)
		return
	}
	log.Printf("%s %s: %v", r.Method, r.URL.Path, err)
	writeError(w, http.StatusInternalServerError, "internal_error", "internal server error")
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	if status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", "Bearer")
	}
	writeJSON(w, status, &apiError{status, code, message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
