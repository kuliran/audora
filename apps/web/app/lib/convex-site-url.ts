function resolveConvexSiteUrl() {
  const explicitSiteUrl = (
    import.meta.env.VITE_CONVEX_SITE_URL as string | undefined
  )?.trim();

  if (explicitSiteUrl) {
    return explicitSiteUrl.replace(/\/+$/, "");
  }

  const deploymentUrl = (
    import.meta.env.VITE_CONVEX_URL as string | undefined
  )?.trim();

  if (!deploymentUrl) {
    throw new Error("VITE_CONVEX_URL is not configured");
  }

  const url = new URL(deploymentUrl);
  if (!url.hostname.endsWith(".convex.cloud")) {
    throw new Error(
      "VITE_CONVEX_SITE_URL is required for local or self-hosted Convex"
    );
  }

  url.hostname = `${url.hostname.slice(0, -".convex.cloud".length)}.convex.site`;
  return url.origin;
}

export const CONVEX_SITE_URL = resolveConvexSiteUrl();
