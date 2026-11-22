package main

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestExampleWorkerTakesMatchingWorkAndPostsResult(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("install Node.js 22 or later to run the example worker test")
	}
	f := newAPIFixture(t)
	_, poster := f.token(t, "demo", "Maintainer", "post,read")
	_, worker := f.token(t, "demo", "Uppercase worker", "take,post")
	_, taker := f.token(t, "demo", "Take-only worker", "take")
	unrelated := f.post(t, poster, "unrelated", `{"kind":"work","action":"review"}`)
	work := f.post(t, poster, "example", `{"kind":"work","action":"uppercase","task":"uppercase-demo","text":"Hello, whiteboard!"}`)

	cert := filepath.Join(t.TempDir(), "whiteboard.pem")
	trust := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: f.server.Certificate().Raw})
	if err := os.WriteFile(cert, trust, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	run := func(token string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, node, "examples/uppercase-worker.mjs")
		cmd.Env = append(cmd.Environ(),
			"BOARD_URL="+f.server.URL+"/api/boards/demo",
			"BOARD_TOKEN="+token,
			"NODE_EXTRA_CA_CERTS="+cert,
		)
		return cmd.CombinedOutput()
	}
	if output, err := run(taker); err == nil || !strings.Contains(string(output), "needs both Take and Post") {
		t.Fatalf("take-only worker should fail before claiming: %v\n%s", err, output)
	}
	f.operator(t, "board", "archive", "demo")
	if output, err := run(worker); err == nil || !strings.Contains(string(output), "Board archived") {
		t.Fatalf("worker should stop on an archived board: %v\n%s", err, output)
	}
	assertEntries(t, f.browse(t, poster, `{"action":"uppercase"}`), work.ID)
	f.operator(t, "board", "reopen", "demo")
	if output, err := run(worker); err != nil {
		t.Fatalf("run worker: %v\n%s", err, output)
	}

	assertEntries(t, f.browse(t, poster, `{"kind":"work"}`), unrelated.ID)
	results := f.browse(t, poster, `{"kind":"result","task":"uppercase-demo"}`)
	if len(results) != 1 {
		t.Fatalf("wanted one result, got %d", len(results))
	}
	var payload struct{ SourceEntryID, Text string }
	if err := json.Unmarshal(results[0].Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.SourceEntryID != work.ID || payload.Text != "HELLO, WHITEBOARD!" {
		t.Fatalf("unexpected result: %+v", payload)
	}
}
