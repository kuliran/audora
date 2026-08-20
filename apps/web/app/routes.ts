import {
    type RouteConfig,
    index,
    layout,
    route,
} from "@react-router/dev/routes";

const authRoutes = [
  route("invite/:code", "routes/invite.$code.tsx"),
  route("sign-in/*", "routes/sign-in.tsx"),
  route("sign-up/*", "routes/sign-up.tsx"),
  route("pricing", "routes/pricing.tsx"),
  route("success", "routes/success.tsx"),
  route("subscription-required", "routes/subscription-required.tsx"),
  route("join/:id", "routes/join.$id.tsx"),
  layout("routes/dashboard/layout.tsx", [
    route("dashboard", "routes/dashboard/index.tsx"),
    route("dashboard/record", "routes/record.tsx"),
    route("dashboard/record/:id", "routes/record.$id.tsx"),
    route("dashboard/conversations/:id", "routes/dashboard/view.$id.tsx"),
    route("dashboard/import", "routes/dashboard/import.tsx"),
    route("dashboard/analytics", "routes/dashboard/analytics.tsx"),
    route("dashboard/chat", "routes/dashboard/chat.tsx"),
    route("dashboard/settings", "routes/dashboard/settings.tsx"),
    route("dashboard/network", "routes/dashboard/network.tsx"),
    route("dashboard/network/:userId", "routes/dashboard/network/$userId.tsx"),
  ]),
];

export default [
  route(".well-known/jwks.json", "routes/local-jwks.ts"),
  route("api/local-auth-token", "routes/local-auth-token.ts"),
  route("api/local-codex", "routes/local-codex.ts"),
  route("apple-touch-icon.png", "routes/apple-touch-icon.ts"),
  route(
    "apple-touch-icon-precomposed.png",
    "routes/apple-touch-icon-precomposed.ts"
  ),
  route("favicon.ico", "routes/favicon-ico.ts"),
  index("routes/home.tsx"),
  route("playground", "routes/playground.tsx"),
  route("waitlist", "routes/waitlist.tsx"),
  route("survey", "routes/survey.tsx"),
  route("manifesto", "routes/manifesto.tsx"),
  route("download", "routes/download.tsx"),
  ...authRoutes,
] satisfies RouteConfig;
