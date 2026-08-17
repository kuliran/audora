# Local Audora + Codex setup

This guide is for the local-first Audora fork on an Apple Silicon Mac. It runs the web app, JWT issuer, Convex backend, database, and macOS audio transcription on loopback or on-device. Communication coaching uses the locally installed Codex CLI authenticated with ChatGPT.

“Local” does not mean fully offline:

| Data or service | Where it runs |
| --- | --- |
| Microphone and system-audio transcription | On-device with Parakeet after its first model download |
| JWT authentication | `http://127.0.0.1:5173` |
| Convex API, HTTP actions, SQLite, and file storage | `http://127.0.0.1:3210` and `http://127.0.0.1:3211` |
| Communication coaching | The local Codex CLI sends selected transcript text and metrics to OpenAI |

Do not use this configuration as a production deployment or on an untrusted/shared machine. See [Security boundary](#security-boundary) before importing sensitive material.

## Prerequisites

- Apple Silicon (`arm64`). Intel Macs are not supported by this local setup.
- macOS 15 or later.
- Full Xcode 16 or later, not only the Command Line Tools. Launch Xcode once to finish installing components and review/accept its license.
- Node.js 24. The local Convex action runtime deliberately rejects Node 25+.
- pnpm 10.29.1, matching the root `packageManager` field.
- Codex CLI 0.143.0 or later installed and logged in with ChatGPT. An OpenAI API key is neither required nor passed to the bridge.
- Internet access for the one-time bootstrap downloads described below.

Check the host before installing dependencies:

```bash
uname -m
sw_vers -productVersion
xcode-select -p
xcodebuild -version
node --version
pnpm --version
codex --version
codex login status
```

Expected highlights are `arm64`, Node `v24.x`, pnpm `10.29.1`, a developer directory below `Xcode.app/Contents/Developer`, and `Logged in using ChatGPT`.

Clone the reviewed branch over SSH, including the separate macOS repository:

```bash
git clone \
  --branch local-codex-parakeet \
  git@github.com:kuliran/audora.git
cd audora
git submodule update --init apps/macos
```

If `xcode-select -p` prints `/Library/Developer/CommandLineTools`, install full Xcode and then select it:

```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
```

If pnpm is missing, Node 24's Corepack can install the repository-pinned version:

```bash
corepack enable
corepack prepare pnpm@10.29.1 --activate
```

If Codex is not already authenticated, run:

```bash
codex login
codex login status
```

Complete the browser flow with ChatGPT. The bridge rejects API-key login and any status other than `Logged in using ChatGPT`. See the official OpenAI documentation for [Codex authentication](https://learn.chatgpt.com/docs/auth) and the [Codex CLI](https://learn.chatgpt.com/docs/codex/cli).

## Install repository dependencies

Run these commands from the repository root:

```bash
git submodule status apps/macos
pnpm install --frozen-lockfile
```

If `git submodule status` begins with `-`, initialize the macOS submodule first:

```bash
git submodule update --init apps/macos
```

Do not use the root `pnpm dev:web` command for this setup. Its dependency filter invokes the backend's ordinary `convex dev` script instead of the hardened local launcher.

## Configure the web process

Create the ignored web environment file if it does not already exist:

```bash
test -e apps/web/.env.local || cp apps/web/.env.example apps/web/.env.local
chmod 600 apps/web/.env.local
```

Generate a bridge token without printing it to the terminal, then paste it into the file when editing it:

```bash
openssl rand -hex 32 | pbcopy
```

Set `apps/web/.env.local` to the following values. Replace the token placeholder with the 64 hexadecimal characters now on the clipboard:

```dotenv
VITE_LOCAL_AUTH=true
VITE_CONVEX_URL=http://127.0.0.1:3210
VITE_CONVEX_SITE_URL=http://127.0.0.1:3211
VITE_CLERK_PUBLISHABLE_KEY=
VITE_CLERK_FRONTEND_API_URL=
CLERK_SECRET_KEY=

AUDORA_CODEX_BRIDGE_TOKEN=<paste-random-64-hex-character-token>

# Optional when the web process cannot find codex on PATH:
AUDORA_CODEX_BIN=/absolute/path/printed/by/command-v-codex
```

The bridge searches `PATH` for `codex`. Determine the optional absolute value with the following command; never use a shell alias or relative path:

```bash
command -v codex
```

Keep `OPENAI_API_KEY`, `SPEECHMATICS_API_KEY`, `ZEP_API_KEY`, VAPI, Notion, Clerk, and other cloud-provider credentials unset for the minimum-traffic configuration.

## Repair older local Convex state once

The hardened launcher now applies `umask 077`, so newly created deployment credentials, SQLite data, uploaded files, and transcripts are private to the current OS account. Older anonymous Convex state may have been created with broader permissions.

With the local backend stopped, run the repository's deliberately scoped repair. It validates the target path, refuses symbolic links, and touches only anonymous Convex state:

```bash
cd packages/backend
pnpm secure:local-state
```

## Launch in order

Use separate terminals and keep the first two processes running.

### 1. Start the web app, JWT issuer, and Codex bridge

From the repository root:

```bash
cd apps/web
pnpm dev
```

The Vite configuration forces `127.0.0.1:5173`, requires both Convex URLs to be exact loopback HTTP URLs, and refuses the local-auth configuration for a normal production build. Start this process first so the Convex backend can reach the JWKS endpoint.

### 2. Start hardened local Convex

In a second terminal:

```bash
cd packages/backend
pnpm dev:local
```

This pins the local backend build and ports, forces the Rust backend to `127.0.0.1`, disables its beacon, redacts server logs from clients, restricts the local dashboard, and creates new state with private permissions.

On first use, Convex creates an anonymous local deployment and writes its generated selector to the ignored `packages/backend/.env.local`. Do not copy that selector or local admin material between machines. The expected local URL is:

```dotenv
CONVEX_URL=http://127.0.0.1:3210
```

If this command reports an unsupported Node version, switch to installed Node 24. `pnpm dev:local:node24` is a fallback, but it uses `npx` and can create additional npm traffic.

### 3. Select Codex inside the running Convex deployment

In a third terminal, set the non-secret runtime values on the local deployment:

```bash
cd packages/backend
printf '%s' 'codex' | pnpm exec convex env set AUDORA_AI_PROVIDER
printf '%s' 'http://127.0.0.1:5173/api/local-codex' | pnpm exec convex env set AUDORA_CODEX_BRIDGE_URL
printf '%s' 'http://127.0.0.1:5173' | pnpm exec convex env set FRONTEND_URL
```

Copy the web bridge token into Convex without putting it in shell history or command-line arguments. If it is still on the clipboard from the earlier setup step:

```bash
pbpaste | pnpm exec convex env set AUDORA_CODEX_BRIDGE_TOKEN
```

The values required by the bridge are therefore exactly:

```dotenv
AUDORA_AI_PROVIDER=codex
AUDORA_CODEX_BRIDGE_URL=http://127.0.0.1:5173/api/local-codex
FRONTEND_URL=http://127.0.0.1:5173
AUDORA_CODEX_BRIDGE_TOKEN=<same-random-token-as-apps/web/.env.local>
```

Convex function environment values are stored in the local deployment; adding these only to `packages/backend/.env.local` is not sufficient.

Verify the non-secret values without reading the bridge token:

```bash
pnpm exec convex env get AUDORA_AI_PROVIDER
pnpm exec convex env get AUDORA_CODEX_BRIDGE_URL
pnpm exec convex env get FRONTEND_URL
```

Expected output is `codex` followed by the two exact `127.0.0.1` URLs above.

Open the authenticated application route directly; the repository root route is only the public landing page:

```bash
open http://127.0.0.1:5173/dashboard
```

## Build and run the Mac app

The fork's shared Xcode configuration already enables `AUDORA_LOCAL_SETUP`, leaves Clerk blank, and fixes the deployment URL to `http://127.0.0.1:3210`.

For the first build, use Xcode so package resolution, signing, and permission prompts are visible:

```bash
open apps/macos/audora.xcodeproj
```

In Xcode:

1. Select the `audora` target and choose your own development team under **Signing & Capabilities** if the upstream team is unavailable.
2. Select the shared `Audora` scheme and **My Mac** destination.
3. Choose **Product → Run**.
4. Grant Microphone and Screen & System Audio Recording access when macOS asks. Calendar access is optional for meeting discovery.

After Xcode has resolved packages and signing, the equivalent command-line Debug build is:

```bash
cd apps/macos
xcodebuild \
  -project audora.xcodeproj \
  -scheme Audora \
  -configuration Debug \
  -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath "$PWD/.build/DerivedData" \
  build
open "$PWD/.build/DerivedData/Build/Products/Debug/audora.app"
```

The Mac app must start after the web and Convex processes. It obtains a 12-hour development JWT from `http://127.0.0.1:5173/api/local-auth-token` and connects only to `http://127.0.0.1:3210` in this build mode. The signing key exists only in the running web process and rotates when that process restarts.

## Parakeet download and local inference

Local Parakeet is fixed as the transcription provider in `AUDORA_LOCAL_SETUP` builds.

The first time a recording starts, FluidAudio downloads and initializes the Parakeet TDT v3 ASR files and a voice-activity-detection model. The recording screen shows status and download progress. Let this complete before expecting transcript text.

Because the app is sandboxed, Audora keeps the Parakeet files below its bundle container:

```text
~/Library/Containers/<bundle-id>/Data/Library/Application Support/Audora/Models/Transcription/parakeet/parakeet-v3/
```

After those files are cached, microphone and system-audio transcription runs on the Apple Silicon Mac. It does not send audio to Speechmatics or OpenAI. Deleting the model cache causes another download. Codex coaching remains online even when Parakeet inference is local.

## Expected network traffic

### First bootstrap

Expect outbound traffic for:

- `pnpm install`: JavaScript packages from package registries.
- Swift Package Manager: the pinned FluidAudio and Convex Swift dependencies from GitHub. Clerk, ConvexClerk, PostHog, Sparkle, and the unused OpenAI Swift package have been removed from the local target and project graph.
- Xcode development signing: Apple services when signing assets are not already present.
- First anonymous Convex launch: the pinned local backend/dashboard artifacts from GitHub and an anonymous local admin-key request to `api.convex.dev`. The launcher suppresses the routine Convex version request, CLI telemetry event, Sentry upload, and backend beacon; it cannot make a brand-new Convex bootstrap fully offline.
- Codex installation and `codex login`: OpenAI/ChatGPT.
- First Parakeet use: Parakeet ASR and VAD model files requested by FluidAudio.

Once packages, Convex artifacts, and Parakeet models are cached, ordinary recording/transcription and storage use only the Mac and loopback Convex. Do not run package installation, package resolution, or model-cache clearing when testing offline behavior.

### Codex transcript egress and quota

Every Codex-backed coaching operation is an external OpenAI request. Depending on the feature, its prompt can contain transcript text, conversation summaries, speech metrics, weak-word context, or chat history. Raw audio is not passed to the Codex bridge.

The bridge:

- requires `codex login status` to report ChatGPT authentication;
- launches `codex exec` in an empty temporary workspace with an ephemeral session, a filesystem profile limited to runtime files and that workspace, shell/app/browser/plugin and web-search tools disabled, user rules/config/skill and environment context omitted, bounded input/output, and a two-minute timeout;
- validates structured output for analysis tasks and deletes its temporary task directory afterward;
- permits only one active request at a time.

Its process boundary follows the official [non-interactive Codex](https://learn.chatgpt.com/docs/non-interactive-mode) and [sandboxing](https://learn.chatgpt.com/docs/sandboxing) guidance, with host-facing tools additionally disabled because transcript content is untrusted.

Because it uses ChatGPT authentication, these calls consume the Codex allowance or credits attached to that ChatGPT account/workspace, not an `OPENAI_API_KEY`. Actual consumption varies with the current Codex model, transcript/context size, output, reasoning, and plan. Local and cloud Codex work may share rolling limits, and additional weekly limits may apply. Check remaining allowance with `/status` in an interactive Codex session or the usage dashboard linked from the official [Codex pricing and limits](https://learn.chatgpt.com/docs/pricing) page.

Data-handling and retention follow the ChatGPT account/workspace used for `codex login`. Review those workspace policies before sending confidential transcripts.

## Verification

### Confirm local endpoints

Run from any terminal after the web and backend processes are ready:

```bash
curl --fail --silent --show-error \
  http://127.0.0.1:5173/.well-known/jwks.json >/dev/null
curl --fail --silent --show-error \
  http://127.0.0.1:3210/version >/dev/null
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  http://127.0.0.1:5173/api/local-auth-token
```

The final command should print `200`.

The Codex bridge must reject a request without its bearer token before starting Codex:

```bash
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{"task":"chat","prompt":"bridge authorization check"}' \
  http://127.0.0.1:5173/api/local-codex
```

Expected status: `401`.

### Confirm loopback listeners

```bash
lsof -nP -iTCP -sTCP:LISTEN |
  grep -E '127\.0\.0\.1:(5173|3210|3211|6790|6791)'
```

Ports `5173`, `3210`, and `3211` must appear on `127.0.0.1`, never `*`, `0.0.0.0`, or `[::]`. Ports `6790` and `6791` are the optional local Convex dashboard and may move if already occupied.

### Optional non-sensitive Codex smoke test

This sends only a fixed test sentence to OpenAI and consumes a small amount of Codex allowance:

```bash
(
  export AUDORA_CODEX_BRIDGE_TOKEN="$(sed -n 's/^AUDORA_CODEX_BRIDGE_TOKEN=//p' apps/web/.env.local)"
  node --input-type=module <<'NODE'
const response = await fetch("http://127.0.0.1:5173/api/local-codex", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AUDORA_CODEX_BRIDGE_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    task: "chat",
    prompt: "Reply with AUDORA_CODEX_OK and nothing else.",
  }),
});
const body = await response.json();
console.log(response.status, body);
if (!response.ok) process.exitCode = 1;
NODE
)
```

Expected status: `200`, with `AUDORA_CODEX_OK` in the result.

### End-to-end Mac check

1. Start a short recording in the Mac app.
2. On first use, wait for Parakeet and VAD download/initialization to complete.
3. Speak a short non-sensitive phrase, then stop the recording.
4. Confirm transcript text appears and the finished conversation is visible at `http://127.0.0.1:5173/dashboard`.
5. Ask a harmless coaching question. This final step tests Codex and therefore sends the selected text to OpenAI and consumes quota.

## Security boundary

This fork is a trusted-single-user development configuration:

- Local authentication represents one fixed `audora-local-user`; it is not account isolation.
- Any process running as the local user can request a local JWT. Browser-origin checks reduce drive-by access to the token and Codex routes but do not defend against malicious software under the same OS account.
- The legacy Convex application contains public functions that were not designed as a complete authorization boundary. Some browsers may also permit hostile sites to reach loopback services. Use disposable test data, keep cloud-provider keys unset, and close the processes when finished.
- Never change the loopback URLs, add a LAN bind, expose the ports through a tunnel/reverse proxy, or deploy with `VITE_LOCAL_AUTH=true`.
- Treat `AUDORA_CODEX_BRIDGE_TOKEN`, Convex local admin state, SQLite files, recordings, and transcripts as sensitive. Never commit them. Keep `apps/web/.env.local` at mode `0600` and the anonymous Convex state at directories `0700`/files `0600`.
- Parakeet keeps audio transcription on-device after model download, but coaching sends text to OpenAI. Do not describe the combined system as offline or fully local.

For the smallest ongoing external footprint, leave every provider key blank, retain `AUDORA_AI_PROVIDER=codex`, use Local Parakeet, avoid the hosted Clerk/Convex commands in the older setup guides, and stop all three local components when testing is complete.
