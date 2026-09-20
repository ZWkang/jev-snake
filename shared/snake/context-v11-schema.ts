import { z } from "zod";
import { renderAsciiBoard, renderNamedBoard } from "./ascii-board.js";
import {
	decisionRequestV6Schema,
	decisionStateV6Schema,
	validateObservedBoardState,
} from "./context-v6-schema.js";

export const decisionRequestV11Schema = z
	.object({
		model: z.string().min(1),
		state: z
			.object({
				...decisionStateV6Schema.shape,
				contextVersion: z.literal("model-planning-v11"),
				strategyGuide: z.string().optional(),
				board: decisionStateV6Schema.shape.board
					.extend({
						ascii: z
							.object({
								format: z.enum(["symbol-grid-v1", "named-cells-v2"]).optional(),
								legend: z.string(),
								map: z.string(),
							})
							.strict()
							.optional(),
					})
					.strict(),
			})
			.strict()
			.superRefine((value, context) => {
				if (context.issues.length) return;
				validateObservedBoardState(value, context);
				if (context.issues.length || !value.board.ascii) return;
				const render =
					value.board.ascii.format === "named-cells-v2"
						? renderNamedBoard
						: renderAsciiBoard;
				const expected = render({
					...value.board,
					bodyHeadToTail: value.player.bodyHeadToTail,
					apple: value.food.apple,
					star: value.food.star?.point ?? null,
				});
				for (const key of ["legend", "map"] as const)
					if (value.board.ascii[key] !== expected[key])
						context.addIssue({
							code: "custom",
							path: ["board", "ascii", key],
							message:
								"The character map must match the complete observed board",
						});
			}),
		questions: decisionRequestV6Schema.shape.questions,
	})
	.strict();
