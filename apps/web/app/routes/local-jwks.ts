import type { Route } from "./+types/local-jwks";
import { LOCAL_AUTH_ISSUER } from "~/lib/local-auth/config";

export async function loader({ request }: Route.LoaderArgs) {
  if (!import.meta.env.DEV || import.meta.env.VITE_LOCAL_AUTH !== "true") {
    return new Response("Not found", { status: 404 });
  }

  if (new URL(request.url).origin !== LOCAL_AUTH_ISSUER) {
    return new Response("Not found", { status: 404 });
  }

  const { getLocalJwks } = await import("~/lib/local-auth/token.server");
  return Response.json(getLocalJwks(), {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
