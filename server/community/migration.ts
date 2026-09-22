import type Database from "better-sqlite3";

export function migrateCommunity(db: Database.Database) {
	db.transaction(() => {
		db.exec(`
   CREATE TABLE community_feedback (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL, visible INTEGER NOT NULL CHECK (visible IN (0,1)), updated_at TEXT NOT NULL);
   CREATE INDEX community_feedback_order ON community_feedback(created_at DESC,id DESC);
   CREATE TABLE community_requests (namespace TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, PRIMARY KEY(namespace,request_id));
   CREATE TABLE contributed_credentials (id TEXT PRIMARY KEY, provider TEXT NOT NULL, fingerprint TEXT NOT NULL, model TEXT NOT NULL, masked_key TEXT NOT NULL, secret_json TEXT, status TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, verified_at TEXT, last_error_json TEXT, UNIQUE(provider,fingerprint));
   CREATE INDEX credential_pool_candidates ON contributed_credentials(provider,model,status,created_at,id);
   CREATE TABLE credential_verifications (request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, credential_id TEXT NOT NULL REFERENCES contributed_credentials(id), provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, result_json TEXT NOT NULL, consent_version TEXT NOT NULL);
   CREATE INDEX credential_verification_key ON credential_verifications(fingerprint,status);
   CREATE TABLE credential_attempts (id TEXT PRIMARY KEY, purpose TEXT NOT NULL, credential_ref TEXT NOT NULL, match_id TEXT, started_at TEXT NOT NULL, data_json TEXT NOT NULL);
   CREATE INDEX credential_attempts_member ON credential_attempts(credential_ref,started_at);
   CREATE TABLE credential_pool_state (provider TEXT PRIMARY KEY, cursor TEXT, environment_fingerprint TEXT, environment_status TEXT NOT NULL, environment_error_json TEXT);
   CREATE TABLE watch_round_credentials (match_id TEXT PRIMARY KEY REFERENCES matches(id), provider TEXT NOT NULL, model TEXT NOT NULL, credential_ref TEXT NOT NULL, reason TEXT NOT NULL);
   PRAGMA user_version = 3;
  `);
	}).immediate();
}
