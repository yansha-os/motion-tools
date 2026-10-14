# First live animation test

This is a supervised smoke test of the installed workflow. Automated fixture results do not substitute for this run.

1. Reload Motion Tools MCP and restart Roblox Studio after installing the current paired plugin. Open Motion Tools and run `motion_installation_diagnostics` plus `motion_agent_resume`. Confirm the reported running builds and session; an unknown build is not proof that the new behavior is loaded.
2. Choose or create an R15 rig in Motion Tools Rig Library. Keep it inside the animation workspace. Inspect the selected rig and check readiness for the exact operations used below. Preserve an existing open draft with an editor read/checkpoint before creating a new candidate.
3. Ask the agent for a subtle looping idle using inspected driven joint names. State the intended motion and what should remain still. Keep the candidate unsaved. Evaluate it, inspect local/composed loop diagnostics, then open the exact fingerprinted candidate.
4. Poll the opening job and follow its editor-read handoff. Confirm candidate fingerprint agreement and the actual playhead. Play through several loop boundaries and manually orbit/zoom to inspect silhouette and visible jumps.
5. Permit screenshots in Studio when prompted. Complete capture preflight, capture front and side views at distinct times, and have the agent retrieve and inspect every PNG. Missing images or partial coverage must remain explicit. Stills do not establish continuous playback quality.
6. Request one small change, such as reduced head sway. Read the current draft first, preserve a checkpoint, preview a local patch with unchanged regions protected, and apply only that exact reviewed candidate against the current draft fingerprint. Verify fresh readback; test Undo/Redo manually.
7. Preserve another checkpoint at a nonzero playhead. Reconnect the agent, find it by topology, and prepare recovery. Protect current unsaved edits before explicitly opening recovery. Verify recipe identity and captured playhead from the fresh editor read. Do not assume selection or undo history was recovered.
8. Run native export validation against the exact reviewed candidate. If the user approves saving, save it and verify its appearance in AnimSaves. Publishing and game integration are separate actions.
9. Repeat with a simple walk cycle. State intended root travel versus in-place motion explicitly; do not force root endpoints to match when travel is intentional. Inspect feet and the rendered wrap from front and side.

Record the session/rig topology, candidate fingerprints, job IDs, screenshot coverage, observed issues, and explicit save decision. A queued job is pending; a failed or unknown job needs reconciliation before retry. Passing this smoke test supports supervised use on these two examples, not unattended creation of every animation or production readiness.
