export const LOCAL_AUTH_ISSUER = "http://127.0.0.1:5173";
export const LOCAL_AUTH_AUDIENCE = "audora-local";
export const LOCAL_AUTH_SUBJECT = "audora-local-user";
export const LOCAL_AUTH_EMAIL = "local@audora.invalid";
export const LOCAL_AUTH_NAME = "Local User";

export function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
