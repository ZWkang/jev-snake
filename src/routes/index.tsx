import { createFileRoute } from "@tanstack/solid-router";
import { HomePage } from "../features/snake/HomePage";
export const Route = createFileRoute("/")({ component: HomePage });
