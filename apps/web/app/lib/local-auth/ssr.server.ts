import { LOCAL_AUTH_SUBJECT } from "./config";

export async function rootAuthLoader() {
  return { localAuth: true };
}

export async function getAuth() {
  return {
    sessionId: "audora-local-session",
    userId: LOCAL_AUTH_SUBJECT,
  };
}
