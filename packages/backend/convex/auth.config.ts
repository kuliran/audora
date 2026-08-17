const LOCAL_AUTH_ISSUER = "http://127.0.0.1:5173";

function isLoopbackDeployment(value: string | undefined) {
  if (!value) return false;

  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port === "3210" &&
      (url.pathname === "" || url.pathname === "/") &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

const localAuthEnabled = isLoopbackDeployment(process.env.CONVEX_CLOUD_URL);

export default localAuthEnabled
  ? {
      providers: [
        {
          type: "customJwt" as const,
          issuer: LOCAL_AUTH_ISSUER,
          jwks: `${LOCAL_AUTH_ISSUER}/.well-known/jwks.json`,
          algorithm: "RS256" as const,
          applicationID: "audora-local",
        },
      ],
    }
  : {
      providers: [
        {
          domain: process.env.VITE_CLERK_FRONTEND_API_URL,
          applicationID: "convex",
        },
      ],
    };
