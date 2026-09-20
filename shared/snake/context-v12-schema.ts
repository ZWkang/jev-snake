import { z } from "zod";
import { decisionRequestV11Schema } from "./context-v11-schema.js";
import { directions, opposite } from "./types.js";

export const decisionRequestV12Schema = z
	.object({
		model: z.string().min(1),
		state: z
			.object({
				...decisionRequestV11Schema.shape.state.shape,
				contextVersion: z.literal("non-reverse-v12"),
			})
			.strict()
			.superRefine((value, context) => {
				if (context.issues.length) return;
				const result = decisionRequestV11Schema.shape.state.safeParse({
					...value,
					contextVersion: "model-planning-v11",
				});
				if (!result.success)
					for (const issue of result.error.issues)
						context.addIssue({ ...issue });
			}),
		questions: z
			.object({
				direction: decisionRequestV11Schema.shape.questions.shape.direction
					.extend({
						criteria: z.partialRecord(
							z.enum(directions),
							z.object({ meaning: z.string() }).strict(),
						),
					})
					.strict(),
			})
			.strict(),
	})
	.strict()
	.superRefine((value, context) => {
		const reverse = opposite[value.state.player.direction];
		for (const direction of directions) {
			const present = Object.hasOwn(
				value.questions.direction.criteria,
				direction,
			);
			if (present !== (direction !== reverse))
				context.addIssue({
					code: "custom",
					path: ["questions", "direction", "criteria", direction],
					message:
						"Choices must contain exactly the three directions other than direct reversal",
				});
		}
	});
