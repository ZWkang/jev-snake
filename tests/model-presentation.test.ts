import { expect, test } from "vitest";
import { createState } from "../server/game/engine.js";
import { decisionBodyV15 } from "../server/jev/board-context.js";
import { compactGrowthRequest } from "../shared/snake/compact-growth.js";
import { publicState } from "../shared/snake/types.js";
import {
	presentDecisionContext,
	presentGrowthSpaceMove,
} from "../src/features/snake/contextPresentation.js";
import {
	decisionModelName,
	modelName,
	providerName,
} from "../src/features/snake/modelPresentation.js";

test.each([
	["laya-typed-decisions", "Laya"],
	["jev-1.13.0", "JEV"],
	["typesafe/jev-1.13", "JEV"],
	["experimental-model", "experimental-model"],
	[null, "玩家"],
	[undefined, "玩家"],
])("model %s keeps its own displayed identity", (model, label) => {
	expect(modelName(model)).toBe(label);
});

test("a resumed match shows its latest decision model and replay keeps each frame's identity", () => {
	const ready = { model: "jev-1.13.0", lastDecision: null };
	const beforeSwitch = {
		...ready,
		lastDecision: { model: "typesafe/jev-1.13" },
	};
	const afterSwitch = {
		...ready,
		lastDecision: { model: "laya-typed-decisions" },
	};
	expect(decisionModelName(ready)).toBe("JEV");
	expect(decisionModelName(afterSwitch)).toBe("Laya");
	expect(decisionModelName(beforeSwitch)).toBe("JEV");
	expect(decisionModelName(afterSwitch)).toBe("Laya");
	expect(afterSwitch.model).toBe("jev-1.13.0");
});

test("decision identity also takes precedence when returning from Laya to JEV", () => {
	expect(
		decisionModelName({
			model: "laya-typed-decisions",
			lastDecision: { model: "jev-1.13.0" },
		}),
	).toBe("JEV");
	expect(decisionModelName({ model: "laya-typed-decisions" })).toBe("Laya");
});

test.each([
	["typesafe", "Typesafe 直连"],
	["openrouter", "OpenRouter"],
	["laya", "Laya 本地服务"],
	["future-provider", "future-provider"],
])(
	"provider %s is displayed without assuming OpenRouter",
	(provider, label) => {
		expect(providerName(provider)).toBe(label);
	},
);

test("saved Laya and JEV requests keep separate model identities without rewriting JSON", () => {
	const state = publicState(
		createState(
			"model-presentation",
			"test",
			null,
			{
				width: 8,
				height: 8,
				obstacleCount: 0,
				tickIntervalMs: null,
				seed: "model-presentation",
				stepMode: "response",
			},
			"now",
		),
	);
	for (const model of ["laya-typed-decisions", "jev-1.13.0"]) {
		const full = decisionBodyV15(state, model);
		for (const request of [full, compactGrowthRequest(full)]) {
			const before = JSON.stringify(request);
			const view = presentDecisionContext(request);
			expect(view.semantics).toContain(`${modelName(model)} 仍`);
			expect(view.request?.model).toBe(model);
			expect(JSON.parse(view.json)).toEqual(request);
			for (const facts of Object.values(request.state.dynamicFacts)) {
				expect(
					presentGrowthSpaceMove(facts, modelName(model)).rejectedArrivals,
				).toContain(`${modelName(model)} 选项`);
			}
			expect(JSON.stringify(request)).toBe(before);
		}
	}
});
