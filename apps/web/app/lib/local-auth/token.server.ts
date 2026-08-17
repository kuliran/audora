import {
  createHash,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  LOCAL_AUTH_AUDIENCE,
  LOCAL_AUTH_EMAIL,
  LOCAL_AUTH_ISSUER,
  LOCAL_AUTH_NAME,
  LOCAL_AUTH_SUBJECT,
} from "./config";

type LocalKeyPair = { privateKey: KeyObject; publicKey: KeyObject };
const localAuthGlobal = globalThis as typeof globalThis & {
  __audoraLocalAuthKeyPair?: LocalKeyPair;
};
const { privateKey, publicKey } = (localAuthGlobal.__audoraLocalAuthKeyPair ??=
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }));

const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
const keyId = createHash("sha256").update(publicKeyDer).digest("base64url");
const publicJwk = publicKey.export({ format: "jwk" }) as Record<string, string>;

function encodeJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function getLocalJwks() {
  return {
    keys: [
      {
        ...publicJwk,
        alg: "RS256",
        kid: keyId,
        use: "sig",
      },
    ],
  };
}

export function createLocalAccessToken() {
  const issuedAt = Math.floor(Date.now() / 1000);
  // The macOS client keeps one Convex token for the recording session. Give it
  // enough time for a long meeting; the key still rotates whenever Vite exits.
  const expiresAt = issuedAt + 12 * 60 * 60;
  const header = encodeJson({ alg: "RS256", kid: keyId, typ: "JWT" });
  const payload = encodeJson({
    aud: LOCAL_AUTH_AUDIENCE,
    email: LOCAL_AUTH_EMAIL,
    exp: expiresAt,
    iat: issuedAt,
    iss: LOCAL_AUTH_ISSUER,
    name: LOCAL_AUTH_NAME,
    nbf: issuedAt - 5,
    sub: LOCAL_AUTH_SUBJECT,
  });
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey).toString("base64url");

  return {
    expiresAt: expiresAt * 1000,
    token: `${signingInput}.${signature}`,
  };
}
