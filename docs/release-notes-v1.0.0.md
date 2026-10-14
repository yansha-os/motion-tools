# Motion Tools v1.0.0

The first version could turn a request into an editable draft. This release adds a review loop so a draft can improve from what you actually see and want changed.

## What changed

- Connect Claude, DeepSeek, or GLM with your own API key in a local browser panel. Change model IDs, control output limits, and see reported usage.
- Inspect an animation on its Studio rig. Scrub front and side joint diagrams, check measured body movement, foot clearance, and loop transitions, and jump to cited sample times.
- Let your chosen AI review the pose data and ask follow-up questions. Add screenshots when you want an image-capable model to review appearance.
- Record what you like, what needs changing, and whether to keep, refine, or redo the version. The next draft receives that feedback and preserves its parent for comparison. Acceptance belongs to you.
- Browse all saved animation versions through **View animations** in Studio. Replay any clip on the selected rig, or replay the last combined animation/VFX preview.
- Use three new MCP review tools alongside the existing rigging, Blender, animation, and VFX tools. There are 30 tools in total.

## Update

From the project folder:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run setup
.\scripts\install-studio-plugin.ps1
```

Restart the old Motion Tools server or MCP connection, then restart Studio so it loads the updated plugin. Connect the plugin, select a rig, and run `npm.cmd run app`. Choose the rig in the panel and generate a draft, or select an older clip and click **Inspect & ask me**.

Setup preserves an existing pairing token and Blender executable setting. The installer backs up the previous plugin. Your ignored `.local/` and `artifacts/` folders remain local, including credentials, saved recipes, and reviews.

## Calls and limitations

Generation makes one API call. AI pose critique is enabled by default and adds one call when Studio samples are available. Disable that checkbox to keep measured inspection and standard questions without the extra call. An optional invalid-recipe repair permits one additional generation call. There is no Motion Tools subscription or shared AI account.

Pose diagrams show evaluated joint positions, not a rendered character. The current project now implements permission-gated rendered viewport capture and AI-visible PNG retrieval through Studio's `StudioCaptureService`; deterministic Luau/integration fixtures cover the workflow, but a live check against the user's current Studio installation is still outstanding. An earlier Studio runtime returned `Feature not supported yet.`, so manual preview-only screenshots remain the fallback when capture is unavailable. VFX has recipe checks and screenshot critique, not a particle simulation inspector. This release improves the iteration workflow; it does not promise finished animation quality.

Automated Node and Luau checks and an isolated browser walkthrough cover the release loop. The sampler and capture workflow still need live Studio checks, and provider adapters were tested with mocked responses rather than paid accounts. See [implementation status](review-implementation-status.md) for details.
