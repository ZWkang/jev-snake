import { createFileRoute } from "@tanstack/solid-router";
import { ContinuousWatchPage } from "../features/snake/ContinuousWatchPage";

export const Route = createFileRoute("/watch/")({
	validateSearch: (search: Record<string, unknown>): { admin?: 1 } => ({
		admin: search.admin === 1 || search.admin === "1" ? 1 : undefined,
	}),
	component: WatchChannelRoute,
});
function WatchChannelRoute() {
	const search = Route.useSearch();
	return <ContinuousWatchPage admin={search().admin === 1} />;
}
