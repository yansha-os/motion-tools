# Open-source reuse review

Last checked: October 12, 2026. Scope: Roblox-native animation-editor components that might materially reduce work on the AI-first Motion Tools workflow. This is a practical compatibility/licensing screen, not legal advice or a complete ecosystem survey.

## Decision

Do not import another animation editor or add a dependency from this pass. Motion Tools needs a native Studio viewport, exact rig/topology binding, MCP-readable authoring state, unsaved candidate previews, evidence capture, and fingerprint-gated apply/export. The reviewed repositories do not provide that integrated contract. Keep the current editor and borrow ideas only where a small, independently testable component solves a demonstrated gap.

## Candidates

| Project | What it provides | License signal | Fit |
| --- | --- | --- | --- |
| [Roblox/otter](https://github.com/Roblox/otter) | Declarative Luau spring/animation library | Repository is marked MIT | Not an animation editor or rig-authoring system. It might help a future spring-driven preview/UI effect, but Motion Tools already owns its interpolation and timeline semantics; adding a dependency now would not remove meaningful work. |
| [Vel136/Heln](https://github.com/Vel136/Heln) | Multi-track `KeyframeSequence` runtime player, blending and marker helpers | Repository states MIT | Runtime playback writes `Motor6D.Transform` and deliberately bypasses `Animator`. That is a poor fit for Motion Tools’ native Roblox export/runtime path and does not help author, inspect, or edit animation in Studio. Reconsider only if a measured runtime playback gap appears. |
| [EXTREME-youtube/Moon-Animator](https://github.com/EXTREME-youtube/Moon-Animator) | Separate, feature-rich Roblox animation plugin | Repository README states MIT and describes the editor | It is a standalone competing editor rather than a component with the MCP/evidence contract we need. Its claimed license applies to that repository; do not assume it grants rights to unrelated Moon Animator code or assets. No code or binary adopted. |
| [mlabajos456/moon-animator-open-source-license](https://github.com/mlabajos456/moon-animator-open-source-license) | Modified Moon Animator binary plus JSON handoff | README claims MIT for modifications and credits an original Moon Animator author | Do not reuse the binary: the repository’s own description identifies it as a modification of another product, and the page does not establish rights for the underlying original code/assets. Its JSON round-trip idea is worth benchmarking later against Motion Tools’ existing recipe import/export, without copying implementation. |
| [Roblox/creator-docs](https://github.com/Roblox/creator-docs) | Official Studio/animation behavior documentation | CC BY 4.0, as stated in its license file | Useful as a behavioral reference and for validating Roblox semantics; it is documentation, not an editor component. Attribute any copied explanatory material as required. |

## Engineering consequence

Keep the project’s own Studio authoring/editor layer and MCP boundary. Prioritize interoperability at explicit formats and guarded workflows (recipe import/export, rig inspection, preview, capture, and native save) rather than embedding a second editor. Revisit reuse when an observable limitation appears—for example, a specific Roblox interpolation/runtime behavior that our tested implementation cannot represent—not merely because another package has a broader feature list.

No dependency, plugin binary, or external source code was added in this review.
