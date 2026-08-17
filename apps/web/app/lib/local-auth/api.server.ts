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

export function createClerkClient() {
  return {
    users: {
      getUser: async () => localUser,
    },
  };
}
