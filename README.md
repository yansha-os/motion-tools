# Roblox Motion Tools

Motion Tools is a local-first, AI-first Roblox animation workbench. It gives an MCP-capable agent—such as Freebuff Desktop—structured tools for understanding a Roblox rig and authoring, previewing, revising, and validating motion. Roblox Studio remains the place where the rig is viewed and where a reviewed animation can become a native Roblox asset.

The project has three parts: a local MCP server, a Roblox Studio plugin with a dedicated animation viewport and editor, and an optional local browser authoring/review panel. The MCP server is not hosted and does not include a built-in general-purpose AI model. Connect an MCP client to use its tools, or configure a supported provider in the optional browser panel. Blender is an optional worker for specific mesh/rig/FBX tasks; it is not required for the Roblox-native animation workflow.

## What Motion Tools does

| Area | Current capabilities |
| --- | --- |
| Roblox Studio workspace | Opens a dedicated animation viewport with a managed rig library, orbit camera, timeline, playback/scrubbing, keyframe selection and editing, markers, and animation-library browsing. Motion Tools-managed rigs are kept out of the game's Workspace view. |
| Rig understanding | Inspects supported Motor6D, AnimationConstraint, and Bone-driven rigs; reports exact driven joints and topology; supports R6/R15 rigs and explicit joint maps. It can connect rigid parts with joints. Rig inspection is structural evidence, not automatic anatomical or visual understanding. |
| Animation authoring | Provides editable idle/walk/cast/slash starters, deterministic rig-mapped walk/run/sneak cycles, pose and phase-based authoring, keyframe patches, easing/curve editing, loop-seam tools, additive/override layers, markers, and immutable revisions. AI agents can compose these tools with their own reasoning. |
| Locomotion | The gait compiler creates **in-place** cycles with limb swing, optional torso motion, support intervals, and markers. Character travel is normally supplied by Roblox Humanoid movement in a game; the gait compiler does not add forward root travel. R6 has no separate elbow or knee joints, so it cannot articulate those joints independently. |
| Advanced motion | Supports rig-aware retarget previews, sampled IK for hand/foot targets, declared-contact baking, reusable poses and pose transitions, secondary-motion layers, multi-clip timelines, and trigger-driven animation graphs. Contacts are authoring constraints/evidence, not physical collision or guaranteed foot locking. |
| Review and testing | Samples motion on a selected Studio rig, audits structure and loop behavior, compares exact revisions on the same rig, supports acceptance plans and regression history, and can attach image evidence when Studio capture is supported and permission is granted. Automated metrics and AI review are not guarantees of artistic quality. |
| VFX (not production-ready) | Some experimental MCP/server and Studio pieces exist for particle/beam recipes, timed previews, and cue sheets. The project does **not** yet provide a complete, dependable VFX-authoring workflow; treat these pieces as prototypes, not a finished particle/beam/energy-column editor. |
| Blender worker | Works on saved `.blend` files for rig inspection, fitting a basic humanoid guide, automatic skin-weight generation/auditing, bone animation, and FBX export. It is an optional specialist workflow, not a replacement for the Studio viewport. |
| Roblox output | Validates animation conversion in Studio and can save an editable KeyframeSequence into the current place after review. Animation publishing, game scripts, and gameplay integration remain separate steps. |
| Local AI panel | Optionally connects Claude, DeepSeek, or GLM (Z.ai) with your own provider API key for generation, measured review, and feedback-driven revisions. Provider use may incur charges. |

Motion Tools is an authoring and inspection toolkit—not an autonomous game builder, general model generator, hosted service, or promise that generated motion is production-ready. Review the animation on the intended rig and in gameplay before release. See [verification limits](docs/review-implementation-status.md) and the [tool reference](docs/tool-reference.md) for the full supported surface.

## Getting started

The setup scripts target Windows. You will need:

- Node.js 22 or newer
- Roblox Studio
- A provider API key for the local authoring panel, or an MCP-compatible chat client
- Blender if you want to use the mesh rigging and FBX tools

Clone the repo and install the dependencies:

```powershell
git clone https://github.com/yansha-os/motion-tools.git
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

This API-key setup is for the optional browser panel's built-in AI generation and provider-backed critique. Core MCP authoring tools do not require a Motion Tools provider key. When Freebuff (or another MCP-capable agent) creates assets through those tools, the agent uses its own model access. If you explicitly enable provider-backed critique in Motion Tools, that feature does use the separately configured provider key and may incur charges.

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
- VFX is incomplete: experimental recipe, preview, and cue-sheet code is present, but it is not a polished, dependable end-to-end creation workflow. Energy-column playback is a Motion Tools preview feature, not a gameplay runtime integration. Do not assume an effect is ready for a game until it has been checked and integrated manually in Studio.
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

This is an authoring workflow, not an autonomous art critic. The connected AI supplies the judgment, and a recorded review does not certify quality. Other MCP servers and existing low-level tools can bypass the workflow. If Studio capture is unavailable, exported screenshots can be attached manually as reference evidence. See [the workflow guide](docs/authoring-workflow.md).

Rendered viewport capture is permission-gated and depends on screenshot support in the running Roblox Studio build. If Studio reports capture unavailable or permission is denied, Motion Tools cannot claim an AI visual review; a user can attach a screenshot as reference instead. Captured images are evidence for review, not automatic proof that an animation is good. See [implementation status](docs/review-implementation-status.md) and [the evaluation plan](docs/review-evaluation.md).

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
