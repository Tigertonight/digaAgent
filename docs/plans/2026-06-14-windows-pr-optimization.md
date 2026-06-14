# Windows PR optimization execution plan

## Core judgment

This Windows packaging PR should not be submitted as-is. The main problem is not a single missing model or one failed build command. The PR lacks a closed loop across source-controlled packaging assets, installer behavior, tray/icon resources, settings reload, provider/model availability, Windows-first onboarding copy, and CI coverage.

## Confirmed blockers

1. `build/installer.nsh` exists locally but is ignored and untracked, so a clean checkout and CI do not include the NSIS hook.
2. The current NSIS hook overrides `customCheckAppRunning` with an empty macro. That suppresses installer detection instead of closing or waiting for the real app process safely.
3. `package.json` references `build/trayTemplate.png`, `build/trayTemplate@2x.png`, and `build/trayIconSource.png`, but those assets are not present in the working tree. `electron-builder` fails before runtime fallback code can help.
4. `electron/main.js` treats any server child exit as fatal and calls `app.quit()`. `settings:reloadServer` intentionally kills the server child, so saving a key and reloading the server can close the whole app.
5. Saving a key through Settings refreshes UI state, but the running standalone server only receives keytar-derived env values on startup. Without a safe reload, the UI can show a stored key while the chat backend still cannot use it.
6. DeepSeek can be stored and detected through keytar/env mapping, but the main chat model dropdown only exposes curated providers. DeepSeek is not in `CURATED_MODEL_OPTIONS`.
7. The first-run provider setup wizard shows macOS quarantine/DMG/Applications text unconditionally, including on Windows.
8. Windows CI only runs on manual dispatch and tags, runs only the updater unit test, and does not protect lint, broader tests, packaging resources, or an installed-app smoke path.

## Additional findings from this review

1. `build/` is ignored, but three macOS helper files under `build/` are already tracked. The fix should not remove or relocate those files casually. Add only the Windows installer hook and missing image assets intentionally.
2. The current local fallback tray icon in `electron/main.js` prevents runtime startup crashes but does not fix packaging, because `extraResources` still requires source files to exist.
3. The app exposes `window.digaAgent.getLocalSecret()` from preload. If renderer fetch header injection is already handled by the main process, this direct secret exposure should be reviewed and either removed or justified.
4. `workflow:sandbox:check` is Unix/macOS oriented and fails on Windows by design. Windows CI should not use it as a required Windows gate unless the script becomes platform-aware.
5. There is no dedicated typecheck script in `package.json`. Windows PR CI should either add one or document why `next build` is the type gate.
6. `lib/subagents/write-boundary.test.ts` expects POSIX paths literally, so `npm test` fails on Windows even when the implementation is behaving consistently with `node:path`.

## Execution split

### Slice A: packaging assets and installer

Owner: packaging worker.

Scope:
- Add tracked tray/icon resources or remove invalid `extraResources` entries if they are not needed.
- Add `build/installer.nsh` to source control despite the `build/` ignore rule.
- Replace the empty NSIS macro with a safer upgrade path that targets Diga Agent only, asks the user when needed, and waits for process exit before install continues.
- Set a real Windows icon if available, or explicitly document unsigned/default-icon limitation as a non-blocking release risk.

Acceptance:
- `git status --short --ignored build` no longer shows required packaging assets as ignored-only.
- `npm run electron:build:win:dir` reaches the Windows toolchain step without missing local resource errors.

### Slice B: settings reload and provider/model chain

Owner: runtime worker.

Scope:
- Make `settings:reloadServer` mark an expected restart before killing the child, so the child `exit` handler does not quit the app.
- Restart the standalone server, reload main/settings windows to the new API base, and surface reload failure without silently closing the app.
- Ensure saved/deleted keys trigger provider refresh after reload.
- Decide DeepSeek behavior: either add a curated DeepSeek option with a real model id known to the registry, or change the UI copy so stored credentials are not implied to be selectable in chat.

Acceptance:
- Saving a key can refresh provider state without app exit.
- Main chat can select every provider intentionally promoted by Settings/onboarding.
- Unit coverage protects the expected restart path if the logic can be isolated.

### Slice C: Windows onboarding copy and local secret boundary

Owner: UI/security worker.

Scope:
- Gate macOS quarantine copy behind platform detection.
- Add Windows-specific first-run copy for Setup/Portable, SmartScreen, first startup delay, and Settings key setup.
- Review `getLocalSecret` exposure. Remove it from preload/type definitions if unused; otherwise document why renderer access is still required.

Acceptance:
- Windows users do not see DMG, `xattr`, or `/Applications` guidance.
- macOS guidance remains available on macOS.
- Preload surface does not expose unnecessary local secrets.

### Slice D: CI and Windows test compatibility

Owner: CI worker.

Scope:
- Add `pull_request` trigger for Windows Electron build checks or create a lighter PR workflow if full packaging is too slow.
- Run lint and a broader Windows-safe test set.
- Fix `write-boundary.test.ts` to compare path-normalized expectations instead of hardcoded POSIX output on Windows.
- Make `workflow:sandbox:check` platform-aware or keep it out of Windows-required gates.
- Add a packaging resource assertion before electron-builder so missing assets fail fast with a clear message.

Acceptance:
- `npm run lint` passes with no new warnings.
- `npm test` passes on Windows.
- Windows CI catches missing packaging assets before release/tag builds.

## Final gates before PR submission

Required:
- `npm run lint`
- `npm test`
- `npm run build:electron`
- `npm run electron:build:win:dir`
- `npm run electron:smoke:win`
- `npm run electron:build:win`

Conditional:
- `npm run electron:smoke:win -- --installer` should run on a clean CI runner. Local machines with an existing Diga Agent install are intentionally blocked unless `DIGA_AGENT_ALLOW_EXISTING_INSTALLER_SMOKE=1` is set.
- Installed-app smoke: launch unpacked app, open Settings, save a test key, reload service, confirm the app remains open and `/api/providers` reflects the updated auth state.

## Current execution status

Completed:
- Packaging resources are now source-controlled or explicitly allowed through `.gitignore`.
- `build/installer.nsh` no longer suppresses app-running detection with an empty macro. It prompts, closes the current user app process without force, waits, and lets the user retry or cancel if the process remains.
- Settings key save/delete now restarts the standalone server as an expected restart path and refreshes provider state after reload.
- DeepSeek is promoted into the curated main-chat provider list.
- First-run provider setup copy is platform-aware, so Windows users no longer see macOS quarantine/DMG guidance.
- Windows CI now runs on PRs with resource checks, lint, tests, sandbox compatibility handling, full Windows packaging, packaged app smoke, and installer smoke.
- `workflow:sandbox:check` now exits cleanly on Windows because the sandbox tools it checks are Unix/macOS only.
- The Windows path-sensitive `write-boundary` test now compares against platform-normalized expectations.
- Windows package smoke mode starts the packaged app without opening UI, waits for the bundled server `/api/health`, then exits.
- Installer smoke supports both clean install and local upgrade validation. If an existing user-level install is detected locally, `DIGA_AGENT_ALLOW_EXISTING_INSTALLER_SMOKE=1` runs a silent upgrade smoke without uninstalling the existing app.
- Silent installer upgrades tolerate broken older uninstallers by continuing with an overwrite install after the current app process is closed.
- Full Windows packaging uses `win.signAndEditExecutable=false` intentionally, so Setup/Portable builds do not depend on the local `winCodeSign` download/resource-editing path.

Verified locally:
- `npm run lint`
- `npm test`
- `npm run build:electron`
- `npm run electron:resources:check`
- `npm run workflow:sandbox:check`
- `npm run electron:build:win:dir`
- `npm run electron:smoke:win`
- `npm run electron:build:win`
- `DIGA_AGENT_ALLOW_EXISTING_INSTALLER_SMOKE=1 npm run electron:smoke:win -- --installer`

Important nuance:
- Local installer smoke has verified the silent upgrade path from an existing user-level Diga Agent install. GitHub Windows runners still verify the clean-install path because they do not start with an existing registry install.
- A real Windows `.ico` app icon is still not present in the repository. This is an accepted limitation for the current unsigned Windows package.

## Submission rule

Do not submit the PR until the clean-checkout packaging path, settings reload path, Windows-first onboarding path, packaged app smoke path, and installer upgrade smoke path are verified. The Windows PR workflow now runs the same full package and installer smoke gates used by release tags, with artifact upload kept to manual/tag events.
