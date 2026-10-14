# Studio capture feasibility

Research date: 2026-09-07; implementation status refreshed 2026-10-10. Status: an earlier installed Studio runtime rejected the capture attempt with `Feature not supported yet.` No PNG was returned in that test. Since then, the plugin capture workflow has been implemented and covered by deterministic Luau fixtures; actual support in the user's currently installed Studio remains unverified.

Runtime evidence: the paired plugin acknowledged `capture_frame` job `fee0a0ae-9dac-4c47-99f9-7681764e4753` as failed on 2026-09-07. The API path is not usable in this installation yet. This result does not identify which internal feature flag is unavailable. Use manual preview-only image export for the pilot; do not claim the automatic capture gate passed.

Roblox's official source documentation identifies `StudioCaptureService` as a Studio plugin service for the active place's **3D viewport**. It is a suitable surface boundary for the pilot, provided the preview is isolated from other scene content. `RequestScreenshotPermissionAsync()` requests plugin capture permission; a disabled global screenshot setting causes refusal. `CanCaptureScreenshot()` checks availability, including active-place and permission conditions, but does not guarantee success. [Official service documentation](https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/classes/StudioCaptureService.yaml)

`CaptureScreenshot()` accepts `Position`, `CaptureSize`, `OutputSize`, `ResampleMode`, `Format`, and `UICaptureMode`. Use PNG and explicitly request `UICaptureMode.None`, since UI inclusion defaults to All. Resampling is required when output size differs from captured size. The requested rectangle must fit the source viewport. These are documented options, not yet a tested implementation. [Capture options](https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/classes/StudioCaptureService.yaml)

The result is a `StudioScreenshotCapture`. Wait for `BufferStatus` to become `Ready` or `Error`, with cancellation and a bounded timeout. Only `Ready` allows `GetBuffer()`, which returns actual image bytes. `BufferFormat.PNG` means PNG-encoded bytes; `GetErrors()` reports failures. This is a byte export path, not an inaccessible temporary image identifier. [Official result documentation](https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/classes/StudioScreenshotCapture.yaml)

## Implemented workflow and remaining checks

`studio/ReviewCapture.lua` now implements a permission-gated preflight, disposable rig-clone pose staging, front/side/back/three-quarter/overhead framing, PNG capture without Studio UI, bounded asynchronous wait, PNG signature and size checks, short-lived capture storage, and chunk retrieval. Capture requests are tied to the selected rig and topology; editor-draft capture additionally revalidates asset, recipe fingerprint, and draft during acquisition and between frames. Screenshot comparison captures multiple alternatives at matched requested times/views, without ranking or saving. MCP tools return actual PNG image blocks only after server-side chunk assembly and validation. The Luau suite uses a mocked capture service to cover success, permission denial, stale rig/draft rejection, camera restoration, partial failure, and size/budget behavior; integration tests cover the MCP handoff and image delivery.

These fixtures validate contracts and cleanup logic, not Roblox's actual StudioCaptureService runtime behavior or the perceptual usefulness of the resulting images. The earlier `Feature not supported yet.` report remains important contrary evidence and must not be erased by the later implementation.

## Remaining live pilot checks

- Connect to the user's current Studio installation and verify the service is available in edit mode after the native permission prompt.
- Capture one fixed pose twice from each supported view. Inspect returned PNGs for pose/camera consistency, framing, and absence of UI; record whether the disposable clone is isolated from the active place.
- Verify capture cancellation, user camera movement, active preview playback, and Studio shutdown/reconnect against the real API.
- Confirm end-to-end image delivery through the configured MCP client at realistic payload sizes. The current path uses bounded local chunks and in-memory MCP image blocks; it does not use an external upload route or persist ordinary captures.

If runtime capture fails, use manually exported preview-only PNG files with a manifest. No whole-desktop capture fallback is permitted. Manual capture still needs matched pose, rig, camera, and time metadata. Automatic capture remains unverified until the live repeated-frame test passes.
