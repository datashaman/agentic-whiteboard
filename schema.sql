CREATE TABLE IF NOT EXISTS boards (
    slug text PRIMARY KEY,
    name text NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    board text NOT NULL REFERENCES boards(slug),
    actor text NOT NULL,
    digest bytea NOT NULL UNIQUE,
    permissions text[] NOT NULL CHECK (
        cardinality(permissions) > 0 AND permissions <@ ARRAY['post', 'read', 'take']
    ),
    revoked_at timestamptz,
    UNIQUE (board, id)
);

CREATE TABLE IF NOT EXISTS entries (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    board text NOT NULL REFERENCES boards(slug),
    payload json NOT NULL CHECK (json_typeof(payload) = 'object'),
    match_data jsonb NOT NULL CHECK (jsonb_typeof(match_data) = 'object'),
    posted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    live boolean NOT NULL DEFAULT true,
    UNIQUE (board, id)
);

CREATE INDEX IF NOT EXISTS entries_live_order ON entries (board, id) WHERE live;

CREATE TABLE IF NOT EXISTS events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    board text NOT NULL,
    token_id bigint NOT NULL,
    entry_id bigint NOT NULL,
    operation text NOT NULL CHECK (operation IN ('post', 'take')),
    at timestamptz NOT NULL DEFAULT clock_timestamp(),
    request_key bytea NOT NULL,
    inputs jsonb NOT NULL,
    FOREIGN KEY (board, token_id) REFERENCES tokens(board, id),
    FOREIGN KEY (board, entry_id) REFERENCES entries(board, id),
    UNIQUE (board, token_id, request_key)
);

CREATE INDEX IF NOT EXISTS events_board_order ON events (board, at DESC, id DESC);
