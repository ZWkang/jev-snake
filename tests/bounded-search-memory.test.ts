import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("repeated former-OOM and full-budget requests retain less than 64 MiB of Bun heap after GC", () => {
	const directory = mkdtempSync(join(tmpdir(), "snake-bounded-memory-"));
	try {
		const script = join(directory, "probe.mjs");
		const client = new URL("../server/jev/search-context.ts", import.meta.url)
			.href;
		const fixture = new URL(
			"./fixtures/board-v6-oom-tick275.json",
			import.meta.url,
		).href;
		writeFileSync(
			script,
			`
import { readFileSync } from 'node:fs';
import { decisionBodyV10 as decisionBody } from ${JSON.stringify(client)};
const old = JSON.parse(readFileSync(new URL(${JSON.stringify(fixture)}), 'utf8'));
const open = {...old, config:{...old.config,width:24,height:18,obstacleCount:0}, obstacles:[], snake:[{x:12,y:9},{x:11,y:9},{x:10,y:9},{x:9,y:9}], direction:'right', apple:{x:0,y:0},star:null};
let maxExpanded = 0;
for (let i=0; i<2000; i++) {
 const r = decisionBody(i%2 ? old : open);
 const s = r.state.localSearch;
 if(s.expandedNodes > s.maxNodes) throw new Error('Search exceeded budget');
 maxExpanded = Math.max(maxExpanded, s.expandedNodes);
}
global.gc();
console.log(JSON.stringify({iterations:2000,maxExpanded,heapMiB:process.memoryUsage().heapUsed/1024/1024,rssKiB:process.resourceUsage().maxRSS}));
`,
		);
		const result = spawnSync(
			process.execPath,
			["--no-env-file", "--expose-gc", script],
			{ cwd: process.cwd(), encoding: "utf8", timeout: 20000 },
		);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.iterations).toBe(2000);
		expect(report.maxExpanded).toBeGreaterThanOrEqual(4998);
		expect(report.heapMiB).toBeLessThan(64);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 25000);
