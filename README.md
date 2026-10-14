# Roblox Motion Tools

An AI-first animation authoring and verification workspace for Roblox. An MCP-capable coding agent—such as Freebuff—is the primary creator; Motion Tools gives it rig-aware tools to author, inspect, preview, refine, and validate motion in Roblox Studio.

The Studio plugin is the native work surface: it provides the isolated animation viewport, rig access, editor, and Roblox export checks. The agent can use structured rig/pose evidence and, when Studio screenshot permission is granted and the MCP client returns images, inspect rendered frames too. That makes the viewport the AI's eyes, while the rig and animation APIs give it precise context. A person remains in control of reviewing and approving saves or exports.

Animation is the product's current focus. Existing VFX, rigging, and Blender-worker capabilities remain available, but Roblox Studio stays the central authoring and review environment; Blender is an optional specialist, not a required part of the animation workflow. The project includes a local MCP server, Studio plugin, optional browser authoring panel, and Blender worker. There is no Motion Tools account or hosted backend.

## What it does

| Area | Included so far |
| --- | --- |
| Rigging | Inspect bones and Roblox joints, connect rigid parts with Motor6Ds, fit a basic humanoid skeleton in Blender, and bind skin weights |
| Animation | Start with idle, walk, cast, or slash motions; compile rig-mapped walk/run/sneak gait cycles with proportion-aware stride estimates and explicit support markers; build quaternion-interpolated transitions between saved poses; retarget complete clips and optionally bake declared hand/foot contacts in one fingerprint-guarded Studio preview; edit individual joint keyframes; retime a complete clip or marker-bounded phase without desynchronizing layers/events/contacts; and save new versions |
| VFX | Build particle effects, beams, and energy columns; save marker-aware cue sheets pinned to exact animation and effect revisions |
| Preview | Review animation and synchronized VFX together in the isolated Motion Tools viewport for managed rigs; Workspace rigs use a temporary preview clone |
| Export | Save Roblox KeyframeSequences or export a Blender rig and its active animation to FBX |
| Authoring workflow | Keep model, animation and VFX briefs, annotated references, preview evidence, reviews and revision history together |
| AI connections | Choose Claude, DeepSeek, or GLM, set a model, and generate or revise drafts using your own API key |
| Animation library | Browse every saved animation revision in Studio, select a clip, and replay it on the selected rig |
| Runtime integration | Turn a fingerprint-verified animation graph into a reusable Luau controller after supplying published animation IDs; typed guards, priority branches, crossfades, one-shot completion, authored marker callbacks, and respawn-safe player binding come from the same graph |
| Review and refinement | Sample the animation on the Studio rig, inspect motion, compare revised trajectories against the exact parent on the same rig, answer follow-up questions, and make a new version from saved feedback |

**v1.0.0** adds the generate, inspect, ask, and revise loop. It is an authoring tool for editable drafts. A valid recipe or a clean inspection does not guarantee a good animation; your judgment drives the next revision. See the [release notes](docs/release-notes-v1.0.0.md) and [verification limits](docs/review-implementation-status.md).

## Getting started

The setup scripts target Windows. You will need:

- Node.js 22 or newer
- Roblox Studio
- A provider API key for the local authoring panel, or an MCP-compatible chat client
- Blender if you want to use the mesh rigging and FBX tools

Clone the repo and install the dependencies:

```powershell
git clone https://github.com/kaziislam11/motion-tools.git
cd motion-tools
npm.cmd ci --ignore-scripts
```

If Blender is not on your PATH, set its location before running setup:

```powershell
$env:BLENDER_EXECUTABLE = 'C:\path\to\blender.exe'
```

Build the server and install the Studio plugin:

```powershell
npm.cmd run setup
.\scripts\install-studio-plugin.ps1
```

For the Freebuff Desktop workflow, use the one-command setup instead:

```powershell
npm.cmd run setup:freebuff
```

This builds Motion Tools, prepares `.local/mcp-config.json` (preserving other MCP server entries), and installs the paired Roblox Studio plugin. In Freebuff Desktop, add a local stdio MCP server named `roblox-motion` using the `command`, `args`, and `env` from `.local/mcp-config.json`. Restart/reload Freebuff so it starts the server, then restart Studio, open **Plugins > Motion Tools**, add or choose a rig in the plugin's **Rig Library**, and click **Connect**. Prompt Freebuff to inspect the active rig and create an animation through Motion Tools; review it in the plugin viewport before asking Freebuff to save it. New built-in R6/R15 rigs are kept under `ServerStorage.MotionToolsRigs`, not in the game viewport. The plugin cannot launch Freebuff or a local process itself.

Do not run `npm start` or `npm run app` while Freebuff is connected: only one process can own the local Studio bridge port. The browser panel and its provider API-key flow remain optional alternatives, not requirements for Freebuff.

Setup creates the plugin and connection files in `.local/`. It preserves an existing Blender executable setting and does not edit your chat client's settings.

### Use your own AI provider

```powershell
npm.cmd run app
```

This opens a local browser panel. Choose **Claude**, **DeepSeek**, or **GLM (Z.ai)**, follow **Get an API key**, then enter the key and click **Save connection**. You can change the model ID before generating. Keys stay in server memory by default. On Windows, **Remember with Windows encryption** stores a DPAPI-protected key in the ignored `.local/` directory. Environment variables are also supported: `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, and `ZAI_API_KEY`.

Open Studio, select a rig, and connect the Motion Tools plugin. In the browser, choose that rig under **Target rig**, write the motion or effect you want, and click **Generate draft**. With inspection enabled, the harness samples the animation, starts its Studio preview, and opens **Watch, judge, refine**. Use **Preview selected** to replay it. For animation saves, **Save to Studio** first runs the real Studio export conversion, then asks you to approve the displayed exact recipe fingerprint and conversion counts before creating the editable native asset. VFX saves do not use the animation export-preflight flow.

The Studio plugin is the native review and save workspace; Freebuff is the AI interface. Choose a rig in the plugin, create/revise through MCP, open the saved recipe in the plugin viewport, and save it to that rig only after review. The browser authoring panel remains an optional legacy workflow and is not needed for Freebuff.

API use is billed by the selected provider. There is no shared Motion Tools AI account or consumer chat login. Saving a connection makes no API call. Each draft uses one generation call. **Ask my AI to review the pose data** is checked by default and adds one critique call when Studio samples are available. Uncheck it for measured inspection and feedback questions without that extra call. An optional repair permits one more call when recipe validation fails. See [provider setup and limits](docs/provider-connections.md).

If the app starts the server, keep its terminal open. If an updated MCP server is already running, the app reuses it. After updating Motion Tools, restart an older server before opening the panel. Only one server can own the Studio bridge port.

### Use Freebuff as the AI agent

The Freebuff Desktop setup above makes Freebuff the agent that decides when to use Motion Tools. The server is a local stdio MCP connector; Roblox Studio's plugin is its live viewport and asset bridge. `.local/mcp-config.json` contains the command, arguments and project-root environment needed to launch it. Add those fields as a local MCP connector in Freebuff Desktop. Motion Tools does not need a separate AI provider API key for this workflow.

Other MCP clients can use the generated server configuration too:

| File | Use |
| --- | --- |
| `.local/mcp-config.json` | MCP clients that accept a JSON `mcpServers` configuration; use its entry to configure Freebuff Desktop |
| `.local/codex-config.toml` | Legacy Codex MCP configuration, if already generated |

Reload your chat client, then restart Studio. Open **Plugins > Motion Tools**, add or choose a rig in the **Rig Library**, and click **Connect**. Allow the plugin to communicate with `127.0.0.1` if Studio asks. Keep Studio in edit mode.

Let your MCP client start the server. Running `npm start` at the same time will cause a port conflict. Use one client connection at a time.

The files in `.local/` contain your pairing token and machine-specific paths. Keep them local. The plugin installer backs up an existing copy before replacing it.

## Try it

Once connected, ask your client to:

> Inspect the active rig in Motion Tools. Create a two-second casting animation, save the recipe to the library, and open it in the Motion Tools Animation Studio viewport. Wait for the Studio job to succeed; don't save it into the place until I approve the preview.

Or refine something you already made:

> Shorten the windup, keep the release at the same point, and save a new version so I can compare them.

For Blender:

> Inspect this saved .blend file. Fit a humanoid rig to the Body mesh and check the skin weights.

The client interprets the request and calls the tools. Animation and effect recipes stay editable, and each saved revision gets its own file. Studio commands return a job ID so the client can check whether the operation actually finished.

## Watch, judge, refine

The v1 harness works on existing library clips as well as new drafts:

1. Select the animation and a live rig, then click **Inspect & ask me**. Choose whether the motion is in place, contains travel, or should stay planted.
2. Watch the Studio preview. The panel shows front and side joint diagrams and measured findings about body movement, foot clearance, and loop transitions. Time links jump to the relevant samples.
3. Answer the follow-up questions. Choose **Keep this version**, **Refine it**, or **Try a different approach**, then describe what should stay and what should change.
4. Click **Save my feedback**. For a revision, click **Make the requested changes**. The next generation receives the original brief, parent recipe, inspection findings, and your keep/change notes. It gets a new library entry and its own inspection.

**Preview previous version** lets you compare the parent. Reviews and feedback survive restarts and belong to the exact recipe that was inspected. The AI cannot accept a version through the critique response.

Pose sampling runs inside Studio using the same joint evaluator as preview. It does not depend on Studio's experimental screenshot API. The diagrams are joint positions, not character renders. To review clothing, silhouette, or an effect's appearance, attach screenshots of that version and click **Ask AI to inspect this evidence** with an image-capable model. VFX has recipe checks and screenshot review; it does not have a simulated motion inspection.

MCP clients can use `motion_review_start`, `motion_review_read`, and `motion_review_feedback` to run the same measured inspection and ask you for feedback in chat. See the [review guide](docs/animation-review.md).

To browse old clips in Studio, click **View animations**, pick a clip, and click **Play selected animation**. The dropdown reads the persistent recipe library, including old revisions and clips created through an MCP client. Duplicate names have date and ID labels. **Refresh animation library** picks up new assets, and the duration field controls playback for up to 30 seconds. The currently selected rig receives the preview.

**Replay last preview** also remains available for replaying an animation together with its timed effects. **Stop preview** removes the temporary copy. The last combined preview is remembered for the current Studio session; the animation library persists across restarts. Clips created only in Roblox's Animation Editor are not imported into this recipe library automatically.

R15 previews support Motor6D and AnimationConstraint joints. Rigid accessories follow welds, rigid constraints, or a uniquely matching avatar attachment. This carries accessories with the body; it does not simulate cape cloth or hair physics.

Blender works on saved `.blend` files. Save your work first, including anything made through another Blender MCP. Each operation writes a new file and returns its path for the next step. The original file is preserved.

## Current limits

- Humanoid rig fitting assumes a Z-up character in a T-pose. It is a starting skeleton, not a general-purpose auto-rigger. Joint placement and skinning need a visual check.
- The animation presets are simple starting motions. They need refinement for a finished game.
- Joint name mapping does not fix differences in bone axes or rest poses. Blender bones with active constraints need those controls baked or disabled in a copy first.
- VFX supports ParticleEmitters, flat native Beams, and growing 3D energy columns with arrival and fade phases. Column playback is currently a Motion Tools preview feature; saved column definitions need a runtime integration for gameplay.
- Preview effects fire once at their assigned times. They do not repeat when the animation loops.
- Publishing animations and adding gameplay code are separate steps. This tool does not upload assets or create combat scripts.

See the [tool reference](docs/tool-reference.md) for the full MCP toolset, including trigger-driven animation graph authoring and route compilation, whole-clip contact baking for alternating foot plants and overlapping supports, preview/visual inspection and fingerprint-guarded apply for coordinated multi-effector IK, world-space IK pole targets for elbow/knee bend-plane control, reusable and analyzable target paths, additive secondary-motion synthesis, pose-transition authoring and offline fingerprinted animation regression benchmarks, recipe details, and the Studio test checklist. There are also [example recipes](examples/) you can use as a starting point.

See the [open-source reuse evaluation](docs/open-source-evaluation.md) for current licensing, compatibility, and integration decisions on related Roblox animation/MCP projects.

## Work from references

For a substantial modeling, animation or VFX request, ask the client to start a Motion Tools workflow. The brief keeps your original request, annotated local references, requirements and things to avoid. The client receives a stage plan and specific review guidance:

- Models: silhouette, surfaces, rigging.
- Animation: key poses, timing, polish.
- VFX: shape, timing, integration.

The client still creates the asset using the existing tools. It then attaches the candidate file and at least two preview images. Motion Tools can return these images to compatible MCP clients for inspection. Reviews must cover every requirement and exclusion and cite that candidate's evidence. Failed or uncertain findings keep the same stage open. Three attempts require a revised approach.

Files are fingerprinted so changed previews cannot silently inherit an earlier review. Briefs and review history persist across restarts in the ignored `artifacts/workflows/` directory. Preserve candidate files under distinct names; the workflow stores their paths and hashes, not backup copies.

This is an authoring workflow, not an autonomous art critic. The connected AI supplies the judgment, and a recorded review does not certify quality. Other MCP servers and existing low-level tools can bypass the workflow. Studio capture is still experimental, so exported images can be attached manually. See [the workflow guide](docs/authoring-workflow.md).

Automatic viewport screenshots remain experimental: the tested Studio installation returned `Feature not supported yet.` The v1 pose inspector and manually attached images work around that dependency. The earlier rendered evaluation pilot is still incomplete; see [implementation status](docs/review-implementation-status.md) and [the evaluation plan](docs/review-evaluation.md).

## Development

If the plugin or connector is unavailable after an update, run `npm.cmd run doctor` (add `-- --json` for structured output). It reads the generated, prepared, and installed plugin, checks pairing and prepared connector paths, and probes the paired local bridge. It reports specific repair steps without changing files or starting another server. After building and reloading the MCP connector, Freebuff can use `motion_installation_diagnostics` for the same file checks and current server session count. Passing installation checks does not establish Studio rig/editor readiness; continue with `motion_agent_resume` and `motion_agent_readiness`.

For JSON without npm’s banner, use `npm.cmd --silent run doctor -- --json` (or `node dist/src/doctor.js --json`).

After rebuilding, the doctor also compares the running bridge’s build fingerprint with current artifacts. Agent resume reports the connected plugin’s build fingerprint separately. A different build needs reload/update; an older installation without build metadata reports unknown. This catches a server or Studio plugin that kept running an old build after its files were updated.

Run the build and tests:

```powershell
npm.cmd test
```

To run the Blender smoke test, set `BLENDER_EXECUTABLE` to your Blender executable, then run:

```powershell
npm.cmd run test:blender
```

The test creates its own mesh, rigs and animates it, checks that the vertices move, and re-imports the exported FBX. Results go in `.local/blender-test/`.

Optional scripts in `scripts/` download checksum-verified copies of Blender 4.5.0 and Luau 0.737 into the project. See [verification](docs/verification.md) for the checks run so far.

With Luau installed, run `node scripts/test-studio.mjs` for accessory bindings, energy-column playback, animation-dropdown checks, and pose-inspection fixtures. Set `LUAU_EXECUTABLE` if your Luau executable is elsewhere.

```text
src/       MCP server, recipes, asset library, and application connections
studio/    Rig inspection, animation, VFX, preview, and plugin panel
web/       Local provider connections, draft authoring, and asset browser
blender/   Blender operations and native verification
scripts/   Build, setup, installation, and test helpers
tests/     Core and MCP integration tests
examples/  Animation and VFX recipes
```

If something breaks, open an issue with the operation you tried, your Blender or Studio version, and the error message. A small test rig or recipe helps. Leave pairing tokens and private assets out of the report.
