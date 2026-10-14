# Open-source reuse evaluation

Review date: 2026-10-13

## Decision

Do not vendor or integrate another full animation editor at this stage. Motion Tools already owns the required Studio viewport, rig isolation, MCP contract, fingerprinted preview/apply lifecycle, and Roblox-native export path. The projects reviewed do not provide a clearly low-risk component that can be dropped into this architecture without replacing or duplicating core behavior.

## Projects reviewed

| Project | Relevant value | License / maturity evidence | Decision |
| --- | --- | --- | --- |
| [alyssagithub/sequence](https://github.com/alyssagithub/sequence) | Roblox Studio plugin with a timeline, curves, IK, pose tools, rig handling, and KeyframeSequence/CurveAnimation import/export. Its README describes a broad native-editor implementation and a test harness. | The repository file listing has no LICENSE file and the README declares no license. GitHub's licensing guidance says that without a license, default copyright applies and others may not reproduce, distribute, or create derivatives. | Do not copy or vendor code. Its feature list is useful only as high-level product research; independently validate any ideas against Roblox APIs and Motion Tools requirements. |
| [EXTREME-youtube/Moon-Animator](https://github.com/EXTREME-youtube/Moon-Animator) | A Studio plugin repository that describes timeline, IK/FK, custom rigs, and camera animation. | README claims MIT, and GitHub displays an MIT license; however, the repository currently shows five commits, three stars, and no listed releases. The repository's name and README do not establish provenance or production quality. | Do not adopt as a dependency. The stated license is permissive, but the limited repository history and absence of a release make this a weak foundation for Motion Tools' production/editor architecture. A later review can inspect code provenance and test compatibility if a specific reusable module becomes relevant. |
| [Roboticela/Animator](https://github.com/Roboticela/Animator) | Desktop/browser skeletal animation tool with a keyframe timeline and GLB import/export. | Repository describes itself as AGPL-3.0 and targets GLB workflows rather than Roblox Studio-native authoring. | Not a fit for the current Roblox-native architecture; the license and format boundary add cost without replacing Studio-specific rig/export behavior. |

## Reuse guidance

- Prefer Roblox Studio APIs and the existing Motion Tools modules for rig inspection, pose composition, timeline editing, capture, validation, and export.
- Reuse a third-party component only after checking its exact source revision, license file and all bundled dependency licenses, compatibility with the current Luau/Studio runtime, maintenance activity, and testability in this repository.
- A repository being public or described as "free" is not sufficient permission to copy or redistribute it. GitHub documents that a license is needed to grant those rights.
- Revisit this review when a concrete feature (for example, curve editing or a tested IK solver) has a measurable implementation gap and a candidate has verifiable provenance and compatible terms.

## Sources

- [Sequence README and repository](https://github.com/alyssagithub/sequence)
- [Moon-Animator repository](https://github.com/EXTREME-youtube/Moon-Animator)
- [Roboticela Animator repository](https://github.com/Roboticela/Animator)
- [GitHub Docs: Licensing a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)
