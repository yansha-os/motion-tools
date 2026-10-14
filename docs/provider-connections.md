# AI connections and the animation library

The local authoring panel sends your brief to the provider you select, validates the returned recipe, and saves an editable draft. It supports animation and VFX generation and revisions. Use an MCP client for the broader tool set, including Blender operations, rigging, and reference-image reviews.

## Connect a provider

Run `npm.cmd run setup`, install the updated Studio plugin with `scripts/install-studio-plugin.ps1`, and run `npm.cmd run app`. Restart Studio after replacing the plugin. If the bridge is already running an older version, restart its MCP connection or terminal first.

The app opens a private local connection link. Its authentication token is removed from the address bar after loading and kept in that browser tab's session storage. Do not share the connection link. For a terminal without a browser, `npm.cmd run app -- --no-open` prints it locally.

| Provider | API | Key source | Default model |
| --- | --- | --- | --- |
| Claude | `https://api.anthropic.com/v1/messages` | [Claude Console](https://platform.claude.com/settings/keys) | `claude-sonnet-5` |
| DeepSeek | `https://api.deepseek.com/chat/completions` | [DeepSeek API keys](https://platform.deepseek.com/api_keys) | `deepseek-v4-flash` |
| GLM | `https://api.z.ai/api/paas/v4/chat/completions` | [Z.ai API keys](https://z.ai/manage-apikey/apikey-list) | `glm-5.3` |

Defaults follow provider documentation checked September 11, 2026. Model access depends on the account, so the model field is editable. Claude has an optional workspace ID field for keys that require one. The GLM connection uses Z.ai's general API endpoint, not its separate Coding Plan endpoint. Consumer chat subscriptions and login cookies are not used by this integration.

Primary documentation: [Claude authentication](https://platform.claude.com/docs/en/manage-claude/authentication), [Claude model IDs](https://platform.claude.com/docs/en/models/overview), [DeepSeek API](https://api-docs.deepseek.com/), and [Z.ai HTTP API](https://docs.z.ai/guides/develop/http/introduction).

## Keys and local data

- Session keys remain in the Node process until it exits or you remove the connection. Browser form fields are cleared after submission. Keys are not stored in browser storage, Studio plugins, places, recipes, or workflow prompts.
- On Windows, remembered keys are encrypted with DPAPI for the current Windows user. The ciphertext and model preferences live in `.local/providers.json`. They cannot be transferred to another Windows account as usable keys. On other operating systems, use a session key or environment variable.
- `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, and `ZAI_API_KEY` provide optional environment credentials. A session or remembered key takes precedence. Removing a saved connection does not unset a process environment variable; the panel reports when one still applies.
- The server listens on `127.0.0.1`. Browser routes require a separate app token and reject other origins. Studio pairing routes continue to reject browser origins. No CORS access is granted to other sites.
- Credentials go only to the selected provider's fixed HTTPS endpoint. Redirects are rejected. Provider error bodies are not returned to the browser or logged.

## Generation and review

Choose a live rig to inspect its animated names before generation. Without a rig, the app explicitly offers a standard R15 draft. It sends the brief, inspected rig data, and the parent recipe if revising. It does not send the rest of the library or arbitrary files.

Each generation uses one provider call up to the selected output token limit. You can permit one additional repair call for invalid recipe data. The panel also enables AI pose review by default: when the draft has real Studio samples, it makes one separate critique call with a 2,500 output token limit. Turn off **Ask my AI to review the pose data** to avoid that call. Measured inspection and the standard feedback questions run locally without an AI call. Manual **Ask AI** requests each make one critique call, with no repair or retry.

There are no automatic retries for authentication, network, billing, or rate-limit errors. Requests time out after two minutes. Cancel stops waiting on the request, but a provider may still bill work already performed. Reported token counts cover responses the app received, not a billing statement. Generation and critique report their usage separately.

Successful drafts are saved under `artifacts/library/`, with provenance under `artifacts/generations/` and a new pending reference workflow under `artifacts/workflows/`. The v1 inspection and feedback records live separately under `artifacts/reviews/`. No quality checks are marked passed automatically. The original user brief is retained alongside the model's interpretation and review checkpoints. Follow [the review loop](animation-review.md) to record what you liked, request changes, and inspect the next version.

Pose critique sends the brief, actual sampled joint positions, measured findings, and saved feedback to the selected provider. Screenshots stay local until you request a critique. Up to eight screenshots can be attached to one review. Select an image-capable model using **Review model ID** when needed; a text-only model may reject images. Screenshot view and time labels describe the requested capture but do not prove the camera or pose was correct. The app does not capture your desktop or send unrelated files. MCP clients can use the paired Studio capture tools and attach returned chunks locally without passing image data through the conversation; native Studio screenshot support remains runtime-dependent.

If you use an MCP coding agent such as Freebuff as the primary AI, it can retrieve Motion Tools' checksum-verified PNG image blocks and inspect them with its own vision-capable model when the MCP client supports image content. This does not require a second Motion Tools critique-provider API key. The optional provider-backed critique is a separate feature that sends selected review evidence to the configured provider. In either workflow, Studio screenshot preflight and the user's permission are required; receiving images is evidence for the AI to inspect, not an automatic quality verdict.

The panel generates recipe data, not arbitrary executable code. Its VFX format supports an emitter, a native beam, or a growing 3D energy column. It cannot create arbitrary effect meshes or gameplay behavior. It does not publish assets. The existing MCP workflow remains available for references, evidence attachments, and recorded reviews.

## Browse and replay

Studio's **View animations** dropdown loads every animation recipe, including old revisions and animations created through other MCP clients using the same project library. Pagination filters by asset kind before slicing results. Names include dates and short IDs so revisions remain distinguishable.

Select a clip and one rig in Workspace, then click **Play selected animation**. Selection is checked again after loading. The preview uses a temporary copy, with the existing accessory-following behavior. The duration field accepts 0.1 to 30 seconds. Looping recipes repeat within that interval; non-looping recipes finish once. **Replay last preview** retains the previous combined animation/VFX replay behavior.

The library survives both server and Studio restarts. It is local to the Motion Tools project directory, not a cloud library or an index of all published Roblox animations. Native Animation Editor clips need a recipe import before they can appear here.

## Verification

`npm.cmd test` covers mock provider responses, request authentication, local key handling, Windows encryption, output validation, bounded repair, cancellation, rig-name checks, immutable revisions, library pagination, and Studio job acknowledgements. Provider calls have not been verified with real paid accounts; connecting your key and generating the first draft exercises that path.
