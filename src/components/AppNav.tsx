import { Link, useRouterState } from "@tanstack/react-router";
import { Bookmark, Heart } from "lucide-react";
import {
	cx,
	navLinkActiveClass,
	navLinkClass,
	navLinkCompactClass,
	navLinkIconClass,
	navLinkLabelClass,
	navLinkLabelCompactClass,
	sidebarBrandClass,
	sidebarBrandCopyClass,
	sidebarBrandCopyCompactClass,
	sidebarBrandMarkClass,
	sidebarBrandTaglineClass,
	sidebarBrandTitleClass,
	sidebarShellCompactClass,
	sidebarFooterClass,
	sidebarNavClass,
	sidebarShellClass,
} from "#/lib/ui";
import { AccountSwitcher } from "./AccountSwitcher";
import { BirdclawMark } from "./BrandMark";
import { ThemeSlider } from "./ThemeSlider";

const links = [
	{ to: "/bookmarks", label: "Bookmarks", icon: Bookmark },
	{ to: "/likes", label: "Likes", icon: Heart },
] as const;

export function AppNav({ compact = false }: { compact?: boolean }) {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});

	return (
		<aside className={compact ? sidebarShellCompactClass : sidebarShellClass}>
			<div className="flex flex-col">
				<Link to="/" className={sidebarBrandClass}>
					<span className={sidebarBrandMarkClass}>
						<BirdclawMark className="size-10" />
					</span>
					<span
						className={
							compact ? sidebarBrandCopyCompactClass : sidebarBrandCopyClass
						}
					>
						<span className={sidebarBrandTitleClass}>birdclaw</span>
						<span className={sidebarBrandTaglineClass}>
							Fast search for your archive.
						</span>
					</span>
				</Link>
				<nav className={sidebarNavClass} aria-label="Primary">
					{links.map((link) => {
						const active = pathname === link.to;
						const Icon = link.icon;
						return (
							<Link
								key={link.to}
								to={link.to}
								aria-label={link.label}
								className={cx(
									compact ? navLinkCompactClass : navLinkClass,
									active && navLinkActiveClass,
								)}
							>
								<Icon
									className={navLinkIconClass}
									size={22}
									strokeWidth={active ? 2.4 : 1.8}
									aria-hidden="true"
								/>
								<span
									className={
										compact ? navLinkLabelCompactClass : navLinkLabelClass
									}
								>
									{link.label}
								</span>
							</Link>
						);
					})}
				</nav>
			</div>
			<div className={sidebarFooterClass}>
				<AccountSwitcher action={<ThemeSlider compact />} />
			</div>
		</aside>
	);
}
