import { Link } from "@tanstack/solid-router";
import { CommunityActions } from "../features/community/CommunityActions";

export default function Header() {
	return (
		<header class="snake-header">
			<Link class="snake-brand" to="/" aria-label="贪吃蛇首页">
				<span class="brand-check" aria-hidden="true" />
				SNAKE<span class="brand-cn">贪吃蛇</span>
			</Link>
			<nav aria-label="主导航">
				<Link
					to="/"
					class="snake-nav-link"
					activeOptions={{ exact: true }}
					activeProps={{ class: "is-active" }}
				>
					首页
				</Link>
				<Link
					to="/watch"
					class="snake-nav-link"
					activeOptions={{ exact: false, includeSearch: false }}
					activeProps={{ class: "is-active" }}
				>
					观战
				</Link>
				<Link
					to="/matches"
					class="snake-nav-link"
					activeOptions={{ exact: false }}
					activeProps={{ class: "is-active" }}
				>
					历史对局
				</Link>
				<Link
					to="/feedback"
					class="snake-nav-link"
					activeProps={{ class: "is-active" }}
				>
					反馈
				</Link>
			</nav>
			<CommunityActions />
			<span class="visitor-label">免登录观战</span>
		</header>
	);
}
