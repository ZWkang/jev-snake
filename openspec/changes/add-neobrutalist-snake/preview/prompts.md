# 生成素材与视频提示词

更新说明：下述整页 ImageGen 图现在仅作为旧版美术参考。用户指出格子未对齐后，当前预览已改为 `index.html`、`history.html`、`replay.html` 中按统一 32 单位格坐标绘制的 HTML/SVG；奖励继续使用生成的透明素材。本次新增页面没有伪造真实 Agent 连接或对局数据。

本轮使用内置 `image_gen`，未使用 CLI/API fallback。页面图为静态视觉预览，奖励图为概念素材；尚未接入产品。用户随后提供了 Seedance 视频；已接入 public/assets/snake/intro.mp4 与 victory.mp4，实际时长分别 6.08 秒与 4.064 秒。

## 页面图初稿

```text
Use case: ui-mockup.
Create one beautifully art-directed high fidelity desktop browser GAME SCREEN concept, landscape 1536x1024, directly edge to edge interface (no browser chrome, no device, no photograph). A playable-looking snake arcade game in bold NEOBRUTALISM, with warm ivory #FFF7E4, ink black #171717 thick 4px outlines, offset solid black shadows, acid yellow #F7F052, coral pink, mint cyan, periwinkle and orange accents. A confident graphic game design, not a SaaS landing page, no soft blurry shadows or decorative gradients.
Composition: modest header with small checker-square mark and heavy black text "SNAKE" alongside Chinese "贪吃蛇". Small pill on right says "设计预览". Below header, a dominant wide ivory 24-by-18 square-cell gridded game board occupying about 70% width, slightly rounded thick black border and 8px hard shadow. Board is the focal point. Right 27% narrow control column with flat horizontal color sections and bold typography: pale yellow score section "本局得分" with huge tabular "120"; lavender speed section "游戏速度" with big "8 格/秒", a chunky black horizontal slider at roughly one third, endpoint labels "4" and "16", visible square "-" and "+" buttons; bright coral "暂停" button; ivory "重新开始" button. Beneath board a compact keyboard legend with individual outlined keycaps and exact text "WASD / ↑↓←→ 移动", "SPACE 暂停", "R 重开", "- / + 调速". Small reward legend "苹果 +10" and "星星 +30".
Inside board: one long continuous 19-segment snake following a clear right-angle grid-aligned winding U/S path, no intersecting segments, thick black contour, alternating vivid coral, golden yellow, mint turquoise and lilac sections with small cel-shaded glossy candy highlight strokes. Clearly recognizable cute head with two large white eyes looking toward a single delicious red apple. Tail tapers. Snake is NOT monochrome, not a smooth gradient line. The apple is an original dimensional cartoon sticker with red cel shading, green leaf, strong black stroke and crisp shine. One yellow 4-point star reward elsewhere with small "8s" tag. About twelve scattered charcoal/dark-purple square rock obstacle cells, each readable with diagonal hatch or X, all separate from snake and food. Subtle white outlined sparkle just near snake head to suggest pickup feedback, no confetti clutter. Board cells and all objects have consistent top-down alignment.
Chinese UI text must be clear and accurate, limited to quoted labels. Strong typographic hierarchy, generous spacing, energetic but very usable screen. All numbers are illustrative. Preserve all edges inside image. No leaderboard, account, store, online mode, graph, website hero, extra panels, or fake photos.
```

## 页面图第一轮修订（旧版美术参考 game-screen.png）

首稿存在偏暗/透明背景、蛇身断开和标题缺失，以下提示词用于修正。原始文件保留于 ImageGen 输出目录。

```text
Edit this snake game UI concept, keeping the right-hand score/speed/buttons layout, colorful segmented candy art direction, obstacle style, red apple, bottom keycap legend, Chinese text and composition.
Fix the following essential rendering problems:
1. Replace ALL dark/transparent background areas with solid OPAQUE warm ivory #FFF7E4. Both page and board must be bright cream. Make the board grid fine pale beige. Remove all diffuse color glows. This is flat, light neo-brutalism with crisp black shadows, not dark neon. No alpha transparency anywhere in this full page screenshot.
2. There must be exactly ONE continuous snake with ONE head and ONE tail. DELETE the entire lower separate U-shaped body. Keep only the upper continuous snake from left pointed tail along a horizontal run, bending down then right to its big-eyed head near the apple. All its body cells touch continuously. Do not add a second snake.
3. Add the missing top-left header "SNAKE / 贪吃蛇" in bold black lettering, with a small checker square symbol. Retain the top-right "设计预览".
4. All keyboard legend and reward legend text must be black and clearly legible on cream background.
Preserve the warm bright yellow score panel "本局得分" "120", lavender speed panel "游戏速度" "8 格/秒" slider endpoints "4" and "16", minus plus buttons, coral "暂停", cream "重新开始", and overall hard black outline aesthetic. Keep obstacle cells dark purple with diagonals, no overlap with snake. Use a 4-point golden star rather than 5-point. This must be an opaque bright polished game-screen mockup, landscape 1536x1024.
```

## 苹果与星星（rewards-concept.png）

```text
Use case: stylized-concept.
Asset type: single 2-cell horizontal game reward concept sprite sheet, for a neobrutalist colorful snake game.
Generate two isolated original collectible icons side by side, centered in equal square cells with generous transparent padding, genuine alpha transparent background. Left: juicy red apple with a single green leaf and short black stem, near-front/top three-quarter stylized view, rounded red/coral lobes, small cream specular highlights. Right: golden yellow four-point twinkle star collectible, angular but slightly soft tips, pale yellow shine and orange lower-right cel shading. Both have same heavy clean ink-black outer contour and small crisp black offset sticker shadow, dimensional hand-inked candy toy style, sharp readable silhouettes at tiny 24px size. Flat vivid colors plus two-tone cel shading; no text, no labels, no face, no frame, no checkerboard drawn into image, no floor or background, no diffuse glow, no photorealism, no object touching the other. Output landscape 1536x768 if available. These are concept assets only, not an animation sheet.
```

## Seedance：可选片头 / 6 秒

```text
6秒，16:9横版，固定正交俯视镜头，新粗野主义游戏美术。奶油白纸面背景、粗黑描边、明确的右下硬阴影。一条且仅一条连续的糖果色贪吃蛇，从画面左侧以直角转弯路线进入；蛇身珊瑚红、亮黄、薄荷青、淡紫交替分节，光滑高光、两只眼睛，轮廓清楚。前2秒蛇进入，中间2秒靠近一颗红苹果，后2秒苹果被吃掉并出现短促星芒，蛇满意地眨眼，停在稳定构图。全程固定镜头，无透视漂移、无镜头缩放、无身体断裂、无第二条蛇、无文字、无水印、无模糊辉光。背景完整不透明，画面边缘留安全区。视频仅用于片头展示，不承担游戏运行或碰撞逻辑。
```

## Seedance：可选获胜短片 / 3 秒

```text
3秒，1:1正方形，固定镜头。奶油白背景，新粗野主义粗黑描边和硬阴影。画面中央一条短小连续的四色糖果蛇轻轻抬头，两颗金色四角星在上方依次弹出，蛇眨眼并回到静止姿势。明快、俏皮、干净，保持头尾连贯与身体形状稳定。少量局部星光，无全屏闪烁、无文字、无水印、无镜头移动、无软阴影和发光背景。保留中央角色四周留白，以便后续叠加真实的游戏结果文案。
```
