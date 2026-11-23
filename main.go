package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:]); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New(usage)
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return errors.New("DATABASE_URL is required")
	}
	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return err
	}
	defer db.Close()
	if len(args) == 1 && args[0] == "serve" {
		return serve(ctx, db)
	}
	return runOperator(ctx, db, os.Stdout, args)
}

func serve(ctx context.Context, db *pgxpool.Pool) error {
	addr := os.Getenv("WHITEBOARD_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	cert, key := os.Getenv("WHITEBOARD_TLS_CERT"), os.Getenv("WHITEBOARD_TLS_KEY")
	if (cert == "") != (key == "") {
		return errors.New("set both WHITEBOARD_TLS_CERT and WHITEBOARD_TLS_KEY to serve HTTPS")
	}
	creation, err := newBoardCreation(os.Getenv("WHITEBOARD_CREATE_TOKEN"), os.Getenv("WHITEBOARD_CREATE_ORIGIN"))
	if err != nil {
		return err
	}
	if err := db.Ping(ctx); err != nil {
		return fmt.Errorf("connect to PostgreSQL: %w", err)
	}
	server := &http.Server{
		Addr:              addr,
		Handler:           newHandler(db, os.Getenv("WHITEBOARD_WEB_DIR"), creation),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      45 * time.Second,
		IdleTimeout:       60 * time.Second,
		BaseContext:       func(_ net.Listener) context.Context { return ctx },
	}
	done := make(chan error, 1)
	go func() {
		if cert != "" {
			done <- server.ListenAndServeTLS(cert, key)
		} else {
			done <- server.ListenAndServe()
		}
	}()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
			return err
		}
		return nil
	}
}
