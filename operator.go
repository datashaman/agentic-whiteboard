package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schemaSQL string

const usage = "usage: whiteboard serve | migrate | board create SLUG NAME | token issue SLUG ACTOR post,read,take | token revoke SLUG ID"

var slugPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

func runOperator(ctx context.Context, db *pgxpool.Pool, output io.Writer, args []string) error {
	switch {
	case len(args) == 1 && args[0] == "migrate":
		return pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(782620435, 1)"); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, schemaSQL)
			return err
		})
	case len(args) == 4 && args[0] == "board" && args[1] == "create":
		if !slugPattern.MatchString(args[2]) || strings.TrimSpace(args[3]) == "" {
			return errors.New("board create requires a URL slug and a nonempty name")
		}
		_, err := db.Exec(ctx, "INSERT INTO boards (slug, name) VALUES ($1, $2)", args[2], args[3])
		return err
	case len(args) == 5 && args[0] == "token" && args[1] == "issue":
		if strings.TrimSpace(args[3]) == "" {
			return errors.New("token issue requires a nonempty actor name")
		}
		permissions, err := parsePermissions(args[4])
		if err != nil {
			return err
		}
		var entropy [32]byte
		if _, err := rand.Read(entropy[:]); err != nil {
			return err
		}
		secret := base64.RawURLEncoding.EncodeToString(entropy[:])
		digest := sha256.Sum256([]byte(secret))
		var id string
		err = db.QueryRow(ctx, `
			INSERT INTO tokens (board, actor, digest, permissions)
			VALUES ($1, $2, $3, $4) RETURNING id::text
		`, args[2], args[3], digest[:], permissions).Scan(&id)
		if err != nil {
			return err
		}
		return json.NewEncoder(output).Encode(struct {
			ID    string `json:"id"`
			Token string `json:"token"`
		}{ID: id, Token: secret})
	case len(args) == 4 && args[0] == "token" && args[1] == "revoke":
		id, err := strconv.ParseInt(args[3], 10, 64)
		if err != nil || id < 1 {
			return errors.New("token revoke requires a valid token ID")
		}
		tag, err := db.Exec(ctx, `
			UPDATE tokens SET revoked_at = COALESCE(revoked_at, clock_timestamp())
			WHERE board = $1 AND id = $2
		`, args[2], id)
		if err == nil && tag.RowsAffected() == 0 {
			return errors.New("token not found on this board")
		}
		return err
	default:
		return errors.New(usage)
	}
}

func parsePermissions(input string) ([]string, error) {
	permissions := []string{}
	for _, part := range strings.Split(input, ",") {
		permission := strings.TrimSpace(part)
		switch permission {
		case "post", "read", "take":
			if !slices.Contains(permissions, permission) {
				permissions = append(permissions, permission)
			}
		default:
			return nil, errors.New("permissions must be a comma-separated list of post, read, take")
		}
	}
	return permissions, nil
}
