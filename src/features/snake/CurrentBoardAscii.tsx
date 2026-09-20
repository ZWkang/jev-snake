import { createMemo } from "solid-js";
import type { PublicState } from "../../../shared/snake/types";
import { presentCurrentBoardAscii } from "./contextPresentation";

export function CurrentBoardAscii(props: { state: PublicState }) {
	const board = createMemo(() => presentCurrentBoardAscii(props.state));
	return (
		<section
			class="snake-panel"
			aria-label="当前回放棋盘字符图"
			style={{ "margin-top": "32px", "min-width": "0" }}
		>
			<h2>{board().title}</h2>
			<p class="decision-input-note">
				依据当前回放帧绘制，与主棋盘同步；此处不是历史模型请求的 HTTP 正文。
			</p>
			<p class="decision-input-note">{board().legend}</p>
			<pre
				aria-label="当前回放棋盘字符图内容"
				tabIndex={0}
				style={{
					"font-family":
						"ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
					"white-space": "pre",
					"overflow-x": "auto",
					"max-width": "100%",
				}}
			>
				{board().map}
			</pre>
		</section>
	);
}
