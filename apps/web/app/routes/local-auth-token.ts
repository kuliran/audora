import type { Route } from "./+types/local-auth-token";
import { LOCAL_AUTH_ISSUER } from "~/lib/local-auth/config";

export async function loader({ request }: Route.LoaderArgs) {
  if (!import.meta.env.DEV || import.meta.env.VITE_LOCAL_AUTH !== "true") {
    return new Response("Not found", { status: 404 });
  }

  const requestUrl = new URL(request.url);
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");

  if (requestUrl.origin !== LOCAL_AUTH_ISSUER) {
    return new Response("Not found", { status: 404 });
  }

  if (origin && origin !== LOCAL_AUTH_ISSUER) {
    return new Response("Forbidden", { status: 403 });
  }

  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return new Response("Forbidden", { status: 403 });
  }

  const { createLocalAccessToken } = await import(
    "~/lib/local-auth/token.server"
  );
  return Response.json(createLocalAccessToken(), {
    headers: {
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
    },
  });
}
