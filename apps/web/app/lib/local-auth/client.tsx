import type { ReactNode } from "react";
import { Navigate } from "react-router";
import {
  LOCAL_AUTH_EMAIL,
  LOCAL_AUTH_NAME,
  LOCAL_AUTH_SUBJECT,
} from "./config";

const localUser = {
  emailAddresses: [{ emailAddress: LOCAL_AUTH_EMAIL }],
  firstName: "Local",
  fullName: LOCAL_AUTH_NAME,
  id: LOCAL_AUTH_SUBJECT,
  imageUrl: "",
  lastName: "User",
  primaryEmailAddress: { emailAddress: LOCAL_AUTH_EMAIL },
};

async function getLocalAccessToken() {
  const response = await fetch("/api/local-auth-token", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`Local authentication failed (${response.status})`);
  }

  const { token } = (await response.json()) as { token: string };
  return token;
}

export function ClerkProvider({ children }: { children: ReactNode }) {
  return children;
}

export function useAuth() {
  return {
    getToken: () => getLocalAccessToken(),
    isLoaded: true,
    isSignedIn: true,
    orgId: null,
    orgRole: null,
    userId: LOCAL_AUTH_SUBJECT,
  };
}

export function useUser() {
  return {
    isLoaded: true,
    isSignedIn: true,
    user: localUser,
  };
}

export function useClerk() {
  return {
    signOut: async ({ redirectUrl = "/" }: { redirectUrl?: string } = {}) => {
      if (typeof window !== "undefined") {
        window.location.assign(redirectUrl);
      }
    },
  };
}

export function SignIn() {
  return <Navigate replace to="/dashboard" />;
}

export function SignUp() {
  return <Navigate replace to="/dashboard" />;
}

export function UserButton() {
  return null;
}

export function SignOutButton({ children }: { children?: ReactNode }) {
  return children ?? null;
}
