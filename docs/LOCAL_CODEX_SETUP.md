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
- Git and SSH access to the parent and macOS repositories.
- An existing Node.js 18 or later installation with `npm`, used only to run the bootstrap. Node 24 and pnpm do not need to be installed globally.
- Codex CLI 0.143.0 or later installed. The bootstrap checks for ChatGPT authentication and opens `codex login` when needed. An OpenAI API key is neither required nor passed to the bridge.
- Internet access for the one-time bootstrap downloads described below.

Clone the reviewed branch over SSH. The setup script initializes the separate macOS repository:

```bash
git clone \
  --branch local-codex-parakeet \
  git@github.com:kuliran/audora.git
cd audora
```

If `xcode-select -p` prints `/Library/Developer/CommandLineTools`, install full Xcode and then select it:

```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
```

## One-time local setup

Run the executable bootstrap directly from the repository root:

```bash
./scripts/setup-local.mjs
```

The script validates the host, full Xcode installation, repository, pinned macOS submodule, and Codex CLI. If Codex is not authenticated with ChatGPT, it opens the official interactive login flow and verifies the result without reading stored credentials. API-key login is rejected by the coaching bridge.

It then:

- installs a private Node 24 runtime and pnpm 10.29.1 below `.audora-local/toolchain`;
- installs only the frozen web/backend dependency graph needed by this setup;
- initializes the macOS submodule when it is missing, while refusing to rewrite a dirty or wrong-revision checkout;
- incrementally builds an optimized, sandboxed Mac app with Xcode's local ad-hoc signature, then runs its short-lived model-preparation mode to download and validate Parakeet TDT v3 and Silero VAD in the real app container;
- creates an **anonymous local Convex deployment without a Convex cloud account**;
- removes known Clerk, OpenAI API, Speechmatics, Zep, VAPI, Notion, and Polar configuration from that anonymous deployment without listing or reading stored values;
- configures the loopback frontend and Codex provider in that deployment;
- repairs private permissions and stops the temporary backend after it is ready.

The bootstrap is idempotent: rerunning it reuses verified downloads, the Xcode build cache, the model cache, and local state, then reapplies safe configuration. Existing model files are loaded for validation rather than downloaded again. Stop the foreground launcher and the Mac app before rerunning setup: setup needs ports `3210` and `3211`, and avoiding simultaneous model activity keeps cache preparation predictable. It fails closed rather than replacing non-anonymous, non-loopback, linked, or unsafe configuration.

The bootstrap uses the normal user-scoped anonymous Convex state so an existing local deployment—and its conversations—survives repository updates and repeated setup runs. It refuses to start if `~/.convex/config.json` exists, because that file represents a Convex cloud login; the script neither reads nor changes those cloud credentials.

The relevant local paths are:

| Path | Contents |
| --- | --- |
| `.audora-local/toolchain` | Repository-private Node 24 and pnpm 10.29.1 |
| `.audora-local/macos-derived-data` | Private incremental Xcode build, including the runnable local Mac app |
| `~/.convex/anonymous-convex-backend-state` | Anonymous deployment credentials, SQLite data, and file storage |
| `~/.cache/convex` | Downloaded local backend and dashboard artifacts |
| `packages/backend/.env.local` | Private anonymous deployment selector and exact loopback URL |

Do not move `.audora-local`, `~/.convex/anonymous-convex-backend-state`, or the selector between untrusted machines, and never commit them. The setup applies `0700` directory and `0600` file permissions to sensitive Convex state. If the selector is missing while anonymous deployment directories remain, or if it names missing state, setup stops instead of silently creating a blank replacement.

See the official OpenAI documentation for [Codex authentication](https://learn.chatgpt.com/docs/auth) and the [Codex CLI](https://learn.chatgpt.com/docs/codex/cli).

## Launch all local services

After setup, run the foreground supervisor directly and leave it running:

```bash
./scripts/dev-local.mjs
```

The launcher re-executes itself under the repository-private Node 24 runtime. It generates a fresh bridge token without printing it or writing it to a source environment file, starts and verifies the web/JWT/Codex process first, starts hardened local Convex, installs the matching token in that anonymous deployment, and waits until the functions are usable. There is no Convex account or first-run selection prompt at launch time.

Logs from the supervisor and its children remain in this terminal with labels such as `[audora]`, `[web]`, `[convex]`, and `[config]`. Keep it open while Audora is running. Press `Ctrl+C` once to stop every managed process; if any required child exits unexpectedly, the supervisor stops the rest.

The ready message includes these local endpoints:

- application: `http://127.0.0.1:5173/dashboard`
- Convex API: `http://127.0.0.1:3210`
- Convex HTTP actions: `http://127.0.0.1:3211`

The launcher pins the Codex bridge to `gpt-5.5` with `medium` reasoning effort by default. You may override either value for one launch:

```bash
AUDORA_CODEX_MODEL=gpt-5.5 \
AUDORA_CODEX_REASONING_EFFORT=low \
./scripts/dev-local.mjs
```

Supported effort values are `low`, `medium`, `high`, and `xhigh`. The bridge permits at most **5 admitted Codex requests in any rolling 5-minute window**, in addition to allowing only one request at a time. A sixth request receives HTTP `429` plus a retry delay. Restarting the web process resets this development-only in-memory window.

The launcher checks that ports `5173`, `3210`, and `3211` are free before starting. If one is occupied, it stops without killing the existing process and prints an `lsof` command for identifying it. A successful launch fixes the services required by the Mac app's “Local services are not ready” screen.

The Vite configuration forces `127.0.0.1:5173`. The hardened Convex launcher pins the backend build and ports, binds to `127.0.0.1`, disables its beacon, redacts server logs from clients, restricts the local dashboard, and reuses `~/.convex/anonymous-convex-backend-state`. The supervisor removes Clerk, OpenAI API, Speechmatics, Zep, VAPI, Notion, Polar, and other cloud-provider variables from its local service environments. Keep those provider credentials out of local environment files as well.

Open the authenticated application route directly; the repository root route is only the public landing page:

```bash
open http://127.0.0.1:5173/dashboard
```

In local mode, the browser recorder is intentionally disabled: a browser cannot run the native CoreML Parakeet pipeline. Record from the Audora Mac app; the browser dashboard receives the locally synced conversation and provides chat, End, and Delete controls. This avoids the old failure mode where **Tap to record** silently attempted cloud Speechmatics without a key.

## Build and run the Mac app

The fork's shared Xcode configuration already enables `AUDORA_LOCAL_SETUP`, leaves Clerk blank, and fixes the deployment URL to `http://127.0.0.1:3210`.

`setup-local.mjs` has already built an optimized Release app using Xcode's ad-hoc **Sign to Run Locally** identity and used that signed app to prepare the models. This does not require an Apple development team. From the repository root, launch the same artifact with:

```bash
open .audora-local/macos-derived-data/Build/Products/Release/audora.app
```

The Mac app must start after the web and Convex processes. It obtains a 12-hour development JWT from `http://127.0.0.1:5173/api/local-auth-token` and connects only to `http://127.0.0.1:3210` in this build mode. The signing key exists only in the running web process and rotates when that process restarts.

You can still develop in Xcode:

```bash
open apps/macos/audora.xcodeproj
```

Select the shared `Audora` scheme and **My Mac** destination. Its Run action uses the optimized Release configuration while retaining `AUDORA_LOCAL_SETUP`. Keep the bundle identifier at its stable default, `com.audora.local`, and use **Sign to Run Locally** to keep subsequent builds attached to the same sandbox container. Grant Microphone and Screen & System Audio Recording access when macOS asks; Calendar access is optional for meeting discovery.

The setup script's equivalent build command is:

```bash
xcodebuild \
  -project apps/macos/audora.xcodeproj \
  -scheme Audora \
  -configuration Release \
  -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath "$PWD/.audora-local/macos-derived-data" \
  -disableAutomaticPackageResolution \
  -onlyUsePackageVersionsFromResolvedFile \
  CODE_SIGN_IDENTITY=- \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM= \
  CODE_SIGNING_ALLOWED=YES \
  CODE_SIGNING_REQUIRED=YES \
  build
```

## Parakeet download and local inference

Local Parakeet is fixed as the transcription provider in `AUDORA_LOCAL_SETUP` builds. During setup, the signed app is launched with a dedicated `--prepare-local-models-and-exit` mode. FluidAudio downloads missing Parakeet TDT v3 and Silero VAD assets into the actual app container, loads them to validate compatibility, and exits without contacting the local backend or requesting audio permissions.

Starting a recording still has to load the cached models into memory, but it should not download them again. The recording screen shows initialization status. Rerunning setup is safe: a valid cache is reused and revalidated. A missing, incomplete, incompatible, manually cleared, or differently identified app container causes the corresponding assets to download again.

Because the app is sandboxed, Audora keeps the Parakeet files below its bundle container:

```text
~/Library/Containers/<bundle-id>/Data/Library/Application Support/Audora/Models/Transcription/parakeet/parakeet-v3/
```

After those files are cached, microphone and system-audio transcription runs on the Apple Silicon Mac. It does not send audio to Speechmatics or OpenAI. Deleting the model cache causes another download. Codex coaching remains online even when Parakeet inference is local.

### Local timestamps and voice metrics

Parakeet token timings and confidence are preserved as word-level transcript data. The Mac also calculates phrase and overall delivery measurements independently for microphone and system audio: pace, articulation rate, pitch range and direction, volume variation, relative phrase volume, cadence steadiness, voiced coverage, and signal-quality flags. Absolute median pitch is available in the local UI.

This analysis is native Swift and runs after each phrase, outside the realtime Core Audio callback. It does not load another model or retain waveform features, pitch contours, voice embeddings, speaker fingerprints, emotion labels, or health/personality inferences. System audio is always marked as a mixed channel and must not be attributed to one person.

The complete local phrase set is stored in the meeting JSON. A rounded, bounded copy (at most 200 evenly sampled phrases per source) is stored in a separate table in the loopback Convex database so conversation lists stay small. Before metrics enter a Codex coaching prompt, absolute median pitch is removed; rates and relative measurements are rounded or converted to categories. Transcript words and phrase rows in the Mac and web UI can seek the saved recording by timestamp.

## Expected network traffic

### First bootstrap

Expect outbound traffic for:

- `./scripts/setup-local.mjs`: the private Node 24 and pnpm packages, followed by the frozen web/backend dependency subset from package registries.
- Initializing `apps/macos`: the pinned macOS submodule from GitHub when it is not already present.
- Swift Package Manager: the pinned FluidAudio and Convex Swift dependencies from GitHub. Clerk, ConvexClerk, PostHog, Sparkle, and the unused OpenAI Swift package have been removed from the local target and project graph.
- Local model preparation: Parakeet ASR and Silero VAD files requested by FluidAudio from its configured model hosts. The setup app uses an ad-hoc local signature, so no Apple development-team request is needed.
- First anonymous Convex bootstrap: the pinned local backend/dashboard artifacts from GitHub and an anonymous local admin-key request to `api.convex.dev`. The hardened bootstrap suppresses the routine Convex version request, CLI telemetry event, Sentry upload, and backend beacon; it cannot create a brand-new anonymous deployment fully offline. This request does not create or require a Convex cloud account.
- `codex login`, when authentication is missing: OpenAI/ChatGPT.

Once packages, the `.audora-local` toolchain and Xcode build, `~/.cache/convex` artifacts, Swift packages, and Parakeet models are cached, ordinary recording/transcription and storage use only the Mac and loopback Convex. Avoid package resolution and model-cache clearing when testing offline behavior; rerun setup after an update or when deliberately revalidating the installation.

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
2. Wait for the already-cached Parakeet and VAD models to load into memory.
3. Speak a short non-sensitive phrase, then stop the recording.
4. Confirm transcript text appears and the finished conversation is visible at `http://127.0.0.1:5173/dashboard`.
5. Ask a harmless coaching question. This final step tests Codex and therefore sends the selected text to OpenAI and consumes quota.

## Security boundary

This fork is a trusted-single-user development configuration:

- Local authentication represents one fixed `audora-local-user`; it is not account isolation.
- Any process running as the local user can request a local JWT. Browser-origin checks reduce drive-by access to the token and Codex routes but do not defend against malicious software under the same OS account.
- The legacy Convex application contains public functions that were not designed as a complete authorization boundary. Some browsers may also permit hostile sites to reach loopback services. Use disposable test data, keep cloud-provider keys unset, and close the processes when finished.
- Never change the loopback URLs, add a LAN bind, expose the ports through a tunnel/reverse proxy, or deploy with `VITE_LOCAL_AUTH=true`.
- Treat `AUDORA_CODEX_BRIDGE_TOKEN`, `.audora-local`, `packages/backend/.env.local`, `~/.convex/anonymous-convex-backend-state`, SQLite files, recordings, and transcripts as sensitive. Never commit or copy them to an untrusted machine. Keep any optional `apps/web/.env.local` at mode `0600`; the setup maintains private permissions for its anonymous Convex state.
- Parakeet keeps audio transcription on-device after model download, but coaching sends text to OpenAI. Do not describe the combined system as offline or fully local.

For the smallest ongoing external footprint, leave every provider key blank, retain `AUDORA_AI_PROVIDER=codex`, use Local Parakeet, avoid the hosted Clerk/Convex commands in the older setup guides, and stop the foreground launcher and Mac app when testing is complete.
