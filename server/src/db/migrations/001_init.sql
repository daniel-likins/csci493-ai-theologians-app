-- Theologians initial schema. Never edit after release; add a new numbered migration instead.
-- Timestamps are ISO-8601 UTC strings. Booleans are 0/1 integers.

-- Workspaces are data: sections group theologian workspaces.
CREATE TABLE sections (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES sections(id),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mission', 'workspace')),
  description TEXT NOT NULL DEFAULT '',
  has_goals INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workspace_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  memory_autosave INTEGER NOT NULL DEFAULT 0,
  memory_suggestions INTEGER NOT NULL DEFAULT 1,
  history_access TEXT NOT NULL DEFAULT 'search' CHECK (history_access IN ('none', 'search')),
  general_context TEXT NOT NULL DEFAULT 'description_and_focus'
    CHECK (general_context IN ('none', 'description', 'description_and_focus')),
  checkin_frequency TEXT NOT NULL DEFAULT 'off'
    CHECK (checkin_frequency IN ('off', 'weekly', 'biweekly', 'monthly')),
  last_checkin_at TEXT,
  checkin_snoozed_until TEXT,
  working_folder TEXT,
  updated_at TEXT NOT NULL
);

-- Provider connection = authentication + endpoint. Secrets are NOT stored here (OS credential store).
CREATE TABLE provider_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  preset TEXT NOT NULL DEFAULT 'custom',
  protocol TEXT NOT NULL
    CHECK (protocol IN ('openai_responses', 'openai_chat', 'anthropic_messages', 'gemini_generate_content')),
  access_type TEXT NOT NULL CHECK (access_type IN ('paid_api', 'institutional', 'local', 'other')),
  base_url TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('api_key', 'bearer_token', 'token_command', 'none')),
  token_command_json TEXT,
  extra_headers_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('unverified', 'verified', 'error', 'expired', 'needs_credentials')),
  status_detail TEXT,
  last_tested_at TEXT,
  last_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Model = the underlying model on a connection and its declared capabilities.
CREATE TABLE models (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  api_model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  context_window INTEGER NOT NULL DEFAULT 32000,
  max_output_tokens INTEGER NOT NULL DEFAULT 4096,
  supports_streaming INTEGER NOT NULL DEFAULT 1,
  supports_tools INTEGER NOT NULL DEFAULT 0,
  supports_images INTEGER NOT NULL DEFAULT 0,
  supports_pdfs INTEGER NOT NULL DEFAULT 0,
  params_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connection_id, api_model_id)
);

-- Assistant profile = instructions, personality, tools, memory scope. Data-access permissions are
-- derived from `kind` by server policy and cannot be changed by editing these text fields.
CREATE TABLE assistant_profiles (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('general', 'goals', 'master')),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  default_key TEXT UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  verbosity TEXT NOT NULL DEFAULT '',
  response_structure TEXT NOT NULL DEFAULT '',
  preferred_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
  tools_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind = 'goals' AND workspace_id IS NOT NULL)
    OR (kind = 'master' AND workspace_id IS NULL)
    OR kind = 'general'
  )
);

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX folders_by_workspace ON folders (workspace_id, sort_order);

-- Conversation = persisted messages + its currently selected assistant/model.
-- workspace_id IS NULL only for the home master Goals conversations.
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('chat', 'goals', 'master')),
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'New chat',
  title_is_custom INTEGER NOT NULL DEFAULT 0,
  selected_profile_id TEXT REFERENCES assistant_profiles(id) ON DELETE SET NULL,
  selected_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
  draft TEXT NOT NULL DEFAULT '',
  draft_attachment_ids_json TEXT NOT NULL DEFAULT '[]',
  draft_updated_at TEXT,
  web_search_enabled INTEGER NOT NULL DEFAULT 0,
  files_enabled INTEGER NOT NULL DEFAULT 0,
  summary_text TEXT,
  summary_through_seq INTEGER NOT NULL DEFAULT 0,
  summary_updated_at TEXT,
  memory_scanned_through_seq INTEGER NOT NULL DEFAULT 0,
  memory_scanned_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT,
  CHECK (
    (kind = 'master' AND workspace_id IS NULL)
    OR (kind IN ('chat', 'goals') AND workspace_id IS NOT NULL)
  )
);
CREATE INDEX conversations_by_workspace ON conversations (workspace_id, kind, updated_at);
CREATE UNIQUE INDEX one_goals_conversation_per_workspace ON conversations (workspace_id) WHERE kind = 'goals';

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL DEFAULT '',
  parts_json TEXT NOT NULL DEFAULT '[]',
  attachment_ids_json TEXT NOT NULL DEFAULT '[]',
  profile_id TEXT,
  profile_name TEXT,
  profile_kind TEXT,
  model_id TEXT,
  model_label TEXT,
  connection_label TEXT,
  status TEXT NOT NULL DEFAULT 'complete'
    CHECK (status IN ('streaming', 'awaiting_approval', 'complete', 'error', 'cancelled', 'interrupted')),
  error_json TEXT,
  usage_json TEXT,
  context_json TEXT,
  superseded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);

CREATE VIRTUAL TABLE messages_fts USING fts5 (
  content,
  message_id UNINDEXED,
  conversation_id UNINDEXED,
  tokenize = 'porter unicode61'
);
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, content, message_id, conversation_id)
  VALUES (new.rowid, new.content, new.id, new.conversation_id);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
  UPDATE messages_fts SET content = new.content WHERE rowid = new.rowid;
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'pdf', 'text', 'unsupported')),
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  extraction_status TEXT NOT NULL
    CHECK (extraction_status IN ('not_needed', 'ok', 'partial', 'no_text', 'unsupported', 'error')),
  extraction_detail TEXT,
  page_count INTEGER,
  char_count INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX attachments_by_conversation ON attachments (conversation_id);

CREATE TABLE attachment_chunks (
  id INTEGER PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  page_start INTEGER,
  page_end INTEGER,
  text TEXT NOT NULL
);
CREATE INDEX attachment_chunks_by_attachment ON attachment_chunks (attachment_id, ordinal);

CREATE VIRTUAL TABLE attachment_chunks_fts USING fts5 (
  text,
  content = 'attachment_chunks',
  content_rowid = 'id',
  tokenize = 'porter unicode61'
);
CREATE TRIGGER attachment_chunks_fts_insert AFTER INSERT ON attachment_chunks BEGIN
  INSERT INTO attachment_chunks_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER attachment_chunks_fts_delete AFTER DELETE ON attachment_chunks BEGIN
  INSERT INTO attachment_chunks_fts (attachment_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

-- Curated, human-editable mission memory.
CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'long_term_goal', 'current_focus', 'progress', 'next_step', 'idea', 'feeling', 'constraint', 'note'
  )),
  certainty TEXT NOT NULL CHECK (certainty IN ('confirmed', 'tentative', 'suggestion')),
  text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('user', 'approved', 'autosave', 'import')),
  source_conversation_id TEXT,
  source_title TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX memory_items_by_workspace ON memory_items (workspace_id, category, deleted_at);

-- Version history: every applied memory change is a change set with before/after snapshots.
CREATE TABLE memory_changes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK (origin IN ('user_edit', 'proposal_approved', 'autosave', 'undo', 'import')),
  summary TEXT NOT NULL,
  proposal_id TEXT,
  undo_of_change_id TEXT,
  undone_by_change_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX memory_changes_by_workspace ON memory_changes (workspace_id, created_at);

CREATE TABLE memory_change_ops (
  id INTEGER PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES memory_changes(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('add', 'update', 'remove')),
  before_json TEXT,
  after_json TEXT
);
CREATE INDEX memory_change_ops_by_change ON memory_change_ops (change_id);

CREATE TABLE memory_proposals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  op TEXT NOT NULL CHECK (op IN ('add', 'update', 'remove')),
  target_item_id TEXT,
  category TEXT,
  certainty TEXT,
  text TEXT,
  reason TEXT NOT NULL DEFAULT '',
  evidence TEXT,
  importance TEXT NOT NULL DEFAULT 'medium' CHECK (importance IN ('low', 'medium', 'high')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('suggestion_scan', 'goals_assistant')),
  source_conversation_id TEXT,
  source_title TEXT,
  source_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'auto_applied', 'duplicate', 'stale')),
  status_detail TEXT,
  change_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX memory_proposals_by_workspace ON memory_proposals (workspace_id, status, created_at);

-- Pending approvals for tool actions (commands, file edits, access outside the working folder).
CREATE TABLE tool_approvals (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('run_command', 'apply_file_edit', 'read_outside_folder')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX tool_approvals_by_conversation ON tool_approvals (conversation_id, status);

-- Transparent accounting of every model call and paid search the app makes.
CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN (
    'chat', 'memory_suggestions', 'summary', 'checkin', 'connection_test', 'web_search'
  )),
  workspace_id TEXT,
  conversation_id TEXT,
  model_id TEXT,
  model_label TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX usage_events_by_time ON usage_events (created_at);

CREATE TABLE preferences (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
