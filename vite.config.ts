import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), "");
	const gameOrigin =
		env.GAME_SERVER_URL || "http://127.0.0.1:" + (env.GAME_PORT || "3001");
	return {
		resolve: { tsconfigPaths: true },
		server: {
			host: "127.0.0.1",
			proxy: {
				"/api": { target: gameOrigin },
				"/ws": { target: gameOrigin.replace(/^http/, "ws"), ws: true },
			},
		},
		preview: {
			host: "127.0.0.1",
			port: 3000,
			strictPort: true,
		},
		plugins: [
			...(env.VITE_ROUTER_DEVTOOLS === "true" ? [devtools()] : []),
			nitro({
				// Nitro handles preview HTTP before Vite's proxy middleware.
				routeRules: {
					"/api/**": { proxy: `${gameOrigin}/api/**` },
				},
				devProxy: {
					"/api/**": { target: gameOrigin, changeOrigin: true },
				},
			}),
			tailwindcss(),
			tanstackStart(),
			solidPlugin({ ssr: true }),
		],
	};
});
