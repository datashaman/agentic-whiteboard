package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type boardCreation struct {
	key    [32]byte
	origin string
}

func newBoardCreation(token, origin string) (*boardCreation, error) {
	if token == "" {
		if origin != "" {
			return nil, errors.New("WHITEBOARD_CREATE_ORIGIN requires WHITEBOARD_CREATE_TOKEN")
		}
		return nil, nil
	}
	secret, err := hex.DecodeString(token)
	if err != nil || len(secret) != 32 {
		return nil, errors.New("WHITEBOARD_CREATE_TOKEN must be a 32-byte hexadecimal secret")
	}
	if origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Hostname() == "" || u.User != nil || u.Scheme+"://"+u.Host != origin {
			return nil, errors.New("WHITEBOARD_CREATE_ORIGIN must be an origin such as https://boards.example.com")
		}
		loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
		if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
			return nil, errors.New("WHITEBOARD_CREATE_ORIGIN must use HTTPS or loopback HTTP")
		}
	}
	return &boardCreation{key: sha256.Sum256([]byte(token)), origin: origin}, nil
}

func (c *boardCreation) handler(db *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Vary", "Origin")
		origin := r.Header.Get("Origin")
		if origin != "" && origin == c.origin {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		} else if origin != "" && r.Header.Get("Sec-Fetch-Site") != "same-origin" {
			writeError(w, http.StatusForbidden, "origin_forbidden", "this browser origin cannot create whiteboards on this server")
			return
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "POST")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		key, ok := bearerDigest(r.Header.Get("Authorization"))
		if !ok || subtle.ConstantTimeCompare(key[:], c.key[:]) != 1 {
			writeError(w, http.StatusUnauthorized, "unauthorized", "a valid server creation token is required")
			return
		}
		c.create(w, r, db)
	}
}

func (c *boardCreation) create(w http.ResponseWriter, r *http.Request, db *pgxpool.Pool) {
	type input struct {
		Slug  string `json:"slug"`
		Name  string `json:"name"`
		Actor string `json:"actor"`
	}
	body, err := decodeRequest[input](w, r)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	body.Actor = strings.TrimSpace(body.Actor)
	if len(body.Slug) > 128 || !slugPattern.MatchString(body.Slug) {
		writeFailure(w, r, invalidRequest("use a URL slug of up to 128 letters, numbers, dots, underscores, or hyphens, starting with a letter or number"))
		return
	}
	for _, value := range []string{body.Name, body.Actor} {
		if value == "" || utf8.RuneCountInString(value) > 200 || strings.ContainsRune(value, 0) {
			writeFailure(w, r, invalidRequest("enter a board name and display name of up to 200 characters"))
			return
		}
	}
	request, err := requestKey(r)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	// Derive the same initial token on retry without storing its plaintext.
	mac := hmac.New(sha256.New, c.key[:])
	_, _ = mac.Write([]byte("whiteboard:create:" + body.Slug + "\x00"))
	_, _ = mac.Write(request[:])
	token := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	digest := sha256.Sum256([]byte(token))
	var tokenID string
	ctx := r.Context()
	err = db.QueryRow(ctx, `
		WITH created AS (
			INSERT INTO boards (slug, name) VALUES ($1, $2)
			ON CONFLICT (slug) DO NOTHING RETURNING slug
		)
		INSERT INTO tokens (board, actor, digest, permissions)
		SELECT slug, $3, $4, ARRAY['post', 'read', 'take'] FROM created
		RETURNING id::text
	`, body.Slug, body.Name, body.Actor, digest[:]).Scan(&tokenID)
	if errors.Is(err, pgx.ErrNoRows) {
		err = db.QueryRow(ctx, `
			SELECT t.id::text FROM boards b JOIN tokens t ON t.board = b.slug
			WHERE b.slug = $1 AND b.name = $2 AND t.actor = $3 AND t.digest = $4 AND t.revoked_at IS NULL
		`, body.Slug, body.Name, body.Actor, digest[:]).Scan(&tokenID)
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusConflict, "board_exists", "a whiteboard with this slug already exists on this server")
			return
		}
	}
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, struct {
		ID      string `json:"id"`
		TokenID string `json:"tokenId"`
		Token   string `json:"token"`
	}{ID: body.Slug, TokenID: tokenID, Token: token})
}
