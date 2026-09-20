import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/solid-router";
import { TanStackRouterDevtools } from "@tanstack/solid-router-devtools";
import "@fontsource/inter/400.css";

import { Show, Suspense } from "solid-js";
import { HydrationScript } from "solid-js/web";
import Header from "../components/Header";
import "../features/snake/snake.css";
import styleCss from "../styles.css?url";

export const Route = createRootRouteWithContext()({
	head: () => ({
		links: [{ rel: "stylesheet", href: styleCss }],
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "SNAKE · 贪吃蛇模型观战" },
			{
				name: "description",
				content: "看模型实时做出方向选择，浏览真实对局与历史回放。",
			},
		],
	}),
	shellComponent: RootComponent,
});

function RootComponent() {
	return (
		<html lang="zh-CN">
			<head>
				<HydrationScript />
				<HeadContent />
			</head>
			<body>
				<Suspense>
					<div class="snake-app">
						<Header />
						<Outlet />
					</div>
					<Show when={import.meta.env.VITE_ROUTER_DEVTOOLS === "true"}>
						<TanStackRouterDevtools />
					</Show>
				</Suspense>
				<Scripts />
			</body>
		</html>
	);
}
