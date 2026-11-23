import { useEffect, useState } from "react";

/** Hash routes: #/ · #/docs[/slug] · #/settings[/tab] · #/new · #/run/<id>[/<stage>] */
export type Route =
  | { page: "home" }
  | { page: "docs"; slug: string }
  | { page: "settings"; tab: "connections" | "account" }
  | { page: "new" }
  | { page: "run"; id: string; stage: string | null };

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  switch (parts[0]) {
    case "docs":
      return { page: "docs", slug: parts[1] ?? "start" };
    case "settings":
      return {
        page: "settings",
        tab: parts[1] === "account" ? "account" : "connections",
      };
    case "new":
      return { page: "new" };
    case "run":
      return parts[1]
        ? { page: "run", id: parts[1], stage: parts[2] ?? null }
        : { page: "home" };
    default:
      return { page: "home" };
  }
}

export const href = (route: Route): string => {
  switch (route.page) {
    case "docs":
      return route.slug === "start" ? "#/docs" : `#/docs/${route.slug}`;
    case "settings":
      return route.tab === "account" ? "#/settings/account" : "#/settings";
    case "new":
      return "#/new";
    case "run":
      return `#/run/${route.id}${route.stage ? `/${route.stage}` : ""}`;
    default:
      return "#/";
  }
};

export const go = (route: Route) => {
  window.location.hash = href(route);
};

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parse(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
