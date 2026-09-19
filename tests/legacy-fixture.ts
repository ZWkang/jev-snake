import { readFileSync } from "node:fs";
import type { Store } from "../server/db/store.js";
import type { MatchState } from "../shared/snake/types.js";

type Snapshot = {
	creation: {
		requestId: string;
		controlToken: string;
		agentName: string;
		config: Record<string, unknown>;
	};
	commands: Record<string, unknown>[];
	tables: Record<
		"matches" | "match_events" | "control_requests",
		Record<string, string>[]
	>;
};
export function legacySnapshot(name: string): Snapshot {
	const data = JSON.parse(
		readFileSync(
			new URL("./fixtures/legacy-matches.json", import.meta.url),
			"utf8",
		),
	) as { snapshots: Record<string, Snapshot> };
	const snapshot = data.snapshots[name];
	if (!snapshot) throw new Error(`Unknown captured legacy snapshot: ${name}`);
	return snapshot;
}
export function loadLegacy(store: Store, name: string) {
	const snapshot = legacySnapshot(name);
	store.db.transaction(() => {
		for (const table of [
			"matches",
			"match_events",
			"control_requests",
		] as const)
			for (const row of snapshot.tables[table]) {
				const columns = Object.keys(row);
				store.db
					.prepare(
						`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
					)
					.run(...columns.map((c) => row[c]));
			}
	})();
	const state = JSON.parse(snapshot.tables.matches[0].state_json) as MatchState;
	return { ...snapshot, state, id: state.id };
}
