import { createFileRoute } from "@tanstack/solid-router";
import { ReplayPage } from "../features/snake/ReplayPage";
export const Route = createFileRoute("/matches/$matchId/replay")({
	component: ReplayRoute,
});
function ReplayRoute() {
	const params = Route.useParams();
	return <ReplayPage matchId={params().matchId} />;
}
