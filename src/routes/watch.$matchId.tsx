import { createFileRoute } from "@tanstack/solid-router";
import { LivePage } from "../features/snake/LivePage";

export const Route = createFileRoute("/watch/$matchId")({
	component: WatchRoute,
});

function WatchRoute() {
	const params = Route.useParams();
	return <LivePage matchId={params().matchId} />;
}
