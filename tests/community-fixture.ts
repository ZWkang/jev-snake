import type Database from "better-sqlite3";
export function removeCommunityFixtureTables(db: Database.Database) {
	db.exec(
		`DROP TABLE watch_round_credentials; DROP TABLE credential_pool_state; DROP TABLE credential_attempts; DROP TABLE credential_verifications; DROP TABLE contributed_credentials; DROP TABLE community_requests; DROP TABLE community_feedback; PRAGMA user_version=2;`,
	);
}
