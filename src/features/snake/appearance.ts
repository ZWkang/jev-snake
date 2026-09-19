import type { GameConfig } from "../../../shared/snake/types";

const classic = ["#ff7286", "#f1db4e", "#66d6bb", "#a697ef", "#ffb15c"];
// One color across the whole snake: mint, sky, coral, gold, lilac, orange,
// rose and teal. Each family has eight palettes, so none dominates the draw.
const solidPalettes = [
	["#48c6a5"],
	["#68afe0"],
	["#f0788d"],
	["#efc64c"],
	["#a48be2"],
	["#f5a45e"],
	["#db83b1"],
	["#49b8be"],
];
const tonalPalettes = [
	["#38b89a", "#66d6bb", "#9be5c7", "#58c9a5"],
	["#529bd5", "#78bce8", "#a1d8ef", "#6caadf"],
	["#e96b83", "#ff91a0", "#ffb5b2", "#f28298"],
	["#e9ac3e", "#f1cb58", "#f5df83", "#efbb4d"],
	["#9480d9", "#b09beb", "#cebbf3", "#a78de2"],
	["#e88b43", "#f5ac67", "#facb91", "#ee9b53"],
	["#c96fa3", "#dc91bc", "#eab4d2", "#d780b0"],
	["#339da8", "#58bac2", "#8fd6d6", "#45adb7"],
];
// Distinct hues repeat along the body: rainbow, berry/mint, blue/orange,
// purple/citrus, peach/sky, green/rose, candy and teal/lilac/gold.
const mixedPalettes = [
	classic,
	["#ed7995", "#72cfae", "#f1b65b", "#ad96dc"],
	["#5cace0", "#f4a261", "#8bd4db", "#ed7f78"],
	["#9c82d9", "#efcc52", "#bfabea", "#b4cf68"],
	["#f2a285", "#7abce0", "#e78faf", "#83cec3"],
	["#64b98d", "#db80a6", "#b2d27c", "#e8b65e"],
	["#e989b5", "#85cce0", "#e9cb66", "#a696e4"],
	["#50b7b8", "#b49bdf", "#ebba55", "#ee958e"],
];
const palettes = [...solidPalettes, ...tonalPalettes, ...mixedPalettes];

// Derive appearance independently of gameplay RNG. A seed keeps its colors
// across live updates, reloads, replay and forks; old records keep their look.
export function snakeColors(
	config: Pick<GameConfig, "seed" | "layoutVersion">,
) {
	if (config.layoutVersion !== 2) return classic;
	let hash = 2166136261;
	for (const character of `snake-colors:${config.seed}`)
		hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
	return palettes[(hash >>> 0) % palettes.length];
}
