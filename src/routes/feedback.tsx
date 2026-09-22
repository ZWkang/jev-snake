import { createFileRoute } from "@tanstack/solid-router";
import { FeedbackPage } from "../features/community/FeedbackPage";
export const Route = createFileRoute("/feedback")({ component: FeedbackPage });
