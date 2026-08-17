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

## Repair older local Convex state once

The hardened launcher now applies `umask 077`, so newly created deployment credentials, SQLite data, uploaded files, and transcripts are private to the current OS account. Older anonymous Convex state may have been created with broader permissions.

With the local backend stopped, run the repository's deliberately scoped repair. It validates the target path, refuses symbolic links, and touches only anonymous Convex state:

```bash
cd packages/backend
pnpm secure:local-state
```

## Launch all local services

Run one command from the repository root and leave it running:

```bash
pnpm dev:local
```

The launcher uses Node 24, generates a fresh bridge token without printing it, starts the web/JWT/Codex process first, starts hardened local Convex, installs the matching token in that local deployment, and waits until the functions are ready. On the first run, choose **Start without an account (run Convex locally)** and accept creation of the anonymous deployment if prompted.

The ready message includes these local endpoints:

- application: `http://127.0.0.1:5173/dashboard`
- Convex API: `http://127.0.0.1:3210`
- Convex HTTP actions: `http://127.0.0.1:3211`

The launcher pins the Codex bridge to `gpt-5.5` with `medium` reasoning effort by default. You may override either value for one launch:

```bash
AUDORA_CODEX_MODEL=gpt-5.5 \
AUDORA_CODEX_REASONING_EFFORT=low \
pnpm dev:local
```

Supported effort values are `low`, `medium`, `high`, and `xhigh`. The bridge permits at most **5 admitted Codex requests in any rolling 5-minute window**, in addition to allowing only one request at a time. A sixth request receives HTTP `429` plus a retry delay. Restarting the web process resets this development-only in-memory window.

This command fixes the services required by the Mac app's “Local services are not ready” screen. Keep it running while Audora is open and press `Ctrl+C` once to stop every child service.

The Vite configuration forces `127.0.0.1:5173`. The hardened Convex launcher pins the backend build and ports, binds to `127.0.0.1`, disables its beacon, redacts server logs from clients, restricts the local dashboard, and creates new state with private permissions. Keep `OPENAI_API_KEY`, `SPEECHMATICS_API_KEY`, `ZEP_API_KEY`, VAPI, Notion, Clerk, and other cloud-provider credentials unset.

Open the authenticated application route directly; the repository root route is only the public landing page:

```bash
open http://127.0.0.1:5173/dashboard
```

In local mode, the browser recorder is intentionally disabled: a browser cannot run the native CoreML Parakeet pipeline. Record from the Audora Mac app; the browser dashboard receives the locally synced conversation and provides chat, End, and Delete controls. This avoids the old failure mode where **Tap to record** silently attempted cloud Speechmatics without a key.

## Build and run the Mac app

The fork's shared Xcode configuration already enables `AUDORA_LOCAL_SETUP`, leaves Clerk blank, and fixes the deployment URL to `http://127.0.0.1:3210`.

For the first build, use Xcode so package resolution, signing, and permission prompts are visible:

```bash
open apps/macos/audora.xcodeproj
```

In Xcode:

1. Select the `audora` target and choose your own development team under **Signing & Capabilities** if the upstream team is unavailable.
2. Select the shared `Audora` scheme and **My Mac** destination. Its Run action is configured for the optimized Release build while retaining `AUDORA_LOCAL_SETUP`.
3. Choose **Product → Run**.
4. Grant Microphone and Screen & System Audio Recording access when macOS asks. Calendar access is optional for meeting discovery.

After Xcode has resolved packages and signing, the equivalent optimized Release build is:

```bash
cd apps/macos
xcodebuild \
  -project audora.xcodeproj \
  -scheme Audora \
  -configuration Release \
  -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath "$PWD/.build/DerivedData" \
  build
open "$PWD/.build/DerivedData/Build/Products/Release/audora.app"
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
- permits only one active request at a time and at most five admitted requests per rolling five-minute window.

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

Open the dashboard Chat page and ask it to reply with `AUDORA_CODEX_OK`. This sends that test prompt and the app's assembled conversation context to OpenAI and consumes one of the five rolling-window requests. A successful reply verifies the complete browser → local Convex → protected loopback bridge → ChatGPT-authenticated Codex path.

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
