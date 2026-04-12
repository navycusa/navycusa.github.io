-- Reference SQL schema for Navy Personnel Portal — QUOTA, requests, reform.
-- Production deployment uses Firestore; this documents relational equivalents.

CREATE TABLE divisions (
  id VARCHAR(64) PRIMARY KEY,
  name TEXT NOT NULL,
  is_headquarters BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE quota_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  division_id VARCHAR(64) NOT NULL REFERENCES divisions(id),
  rank_id VARCHAR(64) NOT NULL,
  period_kind VARCHAR(16) NOT NULL CHECK (period_kind IN ('weekly','monthly')),
  effective_from DATE NOT NULL,
  effective_to DATE,
  rules_json JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE event_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  division_id VARCHAR(64) NOT NULL REFERENCES divisions(id),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  match_event_type TEXT,
  match_custom_name TEXT,
  UNIQUE (division_id, key)
);

CREATE TABLE quota_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_type VARCHAR(16) NOT NULL CHECK (request_type IN ('MDQRA','LOA')),
  requester_uid TEXT NOT NULL,
  division_id VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  reduction_percent NUMERIC(5,2),
  loa_start DATE,
  loa_end DATE,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  decided_by_uid TEXT,
  decision_notes TEXT
);

CREATE TABLE quota_modifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_uid TEXT NOT NULL,
  division_id VARCHAR(64) NOT NULL,
  type VARCHAR(16) NOT NULL CHECK (type IN ('MDQRA','LOA')),
  reduction_percent NUMERIC(5,2),
  start_date DATE NOT NULL,
  end_date DATE,
  source_request_id UUID,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE quota_attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  log_id TEXT NOT NULL,
  user_uid TEXT NOT NULL,
  division_id VARCHAR(64) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  credits INT NOT NULL DEFAULT 1,
  role VARCHAR(16) NOT NULL,
  event_definition_id UUID,
  match_event_type TEXT,
  match_custom_name TEXT,
  is_custom BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE reform_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  division_id VARCHAR(64) NOT NULL,
  week_key VARCHAR(32) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reform_entries (
  snapshot_id UUID NOT NULL REFERENCES reform_snapshots(id) ON DELETE CASCADE,
  user_uid TEXT NOT NULL,
  username TEXT,
  rank_name TEXT,
  required_total NUMERIC(14,4) NOT NULL,
  completed_total NUMERIC(14,4) NOT NULL,
  deficit NUMERIC(14,4) NOT NULL,
  completion_pct NUMERIC(6,2) NOT NULL,
  detail_json JSONB,
  PRIMARY KEY (snapshot_id, user_uid)
);
