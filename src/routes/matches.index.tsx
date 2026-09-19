import { createFileRoute } from "@tanstack/solid-router";
import { HistoryPage } from "../features/snake/HistoryPage";
export const Route = createFileRoute("/matches/")({ component: HistoryPage });
