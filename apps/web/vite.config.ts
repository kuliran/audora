import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const webRoot = fileURLToPath(new URL(".", import.meta.url));

function requireLoopbackUrl(
  name: string,
  value: string | undefined,
  expectedPort: string
) {
  if (!value) {
    throw new Error(`${name} is required when VITE_LOCAL_AUTH=true`);
  }

  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== expectedPort ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      `${name} must be exactly http://127.0.0.1:${expectedPort} when VITE_LOCAL_AUTH=true`
    );
  }
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, webRoot, "");
  const localAuth = env.VITE_LOCAL_AUTH === "true";
  if (localAuth) {
    // Vite does not normally copy non-VITE_ values from .env files into
    // process.env. These stay server-only and are needed by the local bridge.
    for (const name of ["AUDORA_CODEX_BRIDGE_TOKEN", "AUDORA_CODEX_BIN"] as const) {
      if (process.env[name] === undefined && env[name] !== undefined) {
        process.env[name] = env[name];
      }
    }

    const isReactRouterTypegen = process.argv.slice(2).includes("typegen");
    if (command === "build" && !isReactRouterTypegen) {
      throw new Error(
        "VITE_LOCAL_AUTH is development-only and cannot be used for a production build"
      );
    }
    requireLoopbackUrl("VITE_CONVEX_URL", env.VITE_CONVEX_URL, "3210");
    requireLoopbackUrl("VITE_CONVEX_SITE_URL", env.VITE_CONVEX_SITE_URL, "3211");
  }

  const localAuthAliases = localAuth
    ? [
        {
          find: "@clerk/react-router/ssr.server",
          replacement: fileURLToPath(
            new URL("./app/lib/local-auth/ssr.server.ts", import.meta.url)
          ),
        },
        {
          find: "@clerk/react-router/api.server",
          replacement: fileURLToPath(
            new URL("./app/lib/local-auth/api.server.ts", import.meta.url)
          ),
        },
        {
          find: "@clerk/react-router",
          replacement: fileURLToPath(
            new URL("./app/lib/local-auth/client.tsx", import.meta.url)
          ),
        },
      ]
    : [];

  return {
    plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
    resolve: {
      alias: localAuthAliases,
    },
    server: localAuth
      ? {
          host: "127.0.0.1",
          port: 5173,
          strictPort: true,
        }
      : undefined,
    optimizeDeps: {
      exclude: ["@vapi-ai/server-sdk"],
    },
    ssr: {
      noExternal: [],
      external: ["@vapi-ai/server-sdk"],
    },
  };
});
