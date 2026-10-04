# Antigravity OAuth Plus for Hermes

[![CI](https://github.com/taylorwtf/hermes-antigravity-oauth-plus/actions/workflows/release.yml/badge.svg)](https://github.com/taylorwtf/hermes-antigravity-oauth-plus/actions/workflows/release.yml)

Google Antigravity via the official CLI, with live model discovery, native context detection and account quota monitoring.

This standalone project is maintained by **taylorwtf**, version **0.2.0**, at <https://github.com/taylorwtf/hermes-antigravity-oauth-plus>. Its plugin and provider ID is `antigravity-oauth-plus`; aliases are `agy-oauth-plus` and `google-antigravity-plus`. It does not replace the upstream `antigravity-oauth`, `google-antigravity` or `agy-oauth` providers. It is not an official Google or Nous Research product; catalog submission is subject to maintainer review.

## Install and select

Requirements: Hermes Agent **0.21.5 or newer**, Google's official `agy` CLI from <https://antigravity.google/cli>, and **Node.js 20 or newer** for the quota backend/widget. Provider fixtures are tested against Hermes commit `95db0e2ada43296b19b619f5542262ecbaef9482`.

```bash
hermes plugins install https://github.com/taylorwtf/hermes-antigravity-oauth-plus --enable
hermes auth add antigravity-oauth-plus
hermes model
```

Choose **Google Antigravity (OAuth Plus)** and a model returned for your account. For reproducible installation, add `--ref <full-40-character-reviewed-commit>` to the install command. Restart Hermes after installation if the provider is not visible. To stop using the fork, select another provider, then use `hermes plugins disable antigravity-oauth-plus` or `hermes plugins remove antigravity-oauth-plus`. This does not log out agy or delete its credentials.

There is no npm release of this fork. Do **not** use `npx hermes-antigravity-oauth`: that is the upstream package, not OAuth Plus. The inherited `bin/cli.js` and version helper are legacy upstream distribution files, not a supported fork installer. `package.json` is private and exposes no npm binary.

## Models and native context detection

The provider discovers what the installed official `agy models` reports for the signed-in user's account, rather than advertising a fixed vendor catalog. Availability, region, plan and rollout remain Google's decisions; discovering an ID does not guarantee a successful inference request or access to an unreleased model.

The current parser accepts lowercase CLI-style IDs containing a hyphen and ASCII letters/digits/dots/underscores/hyphens. Headers, progress text, options and failed command output are excluded. Other output formats or IDs outside this grammar are not discovered automatically. Known Gemini Flash and `gemini-3.1-pro` effort variants are grouped into base-model choices handled by the inherited reasoning resolver. Other model IDs, including unfamiliar Gemini families, are retained exactly. A failed listing produces no fabricated fallback catalog. Legacy client shorthand aliases remain compatibility conveniences, not availability evidence; prefer IDs from the live picker.

The provider returns `None` for its context-length hook by default, allowing Hermes to use its native model metadata and your explicit `model_overrides`. It sets **no blanket 200k or 1M context window** and duplicates no full model catalog. Unknown IDs still use Hermes' own unknown-model fallback: this is not an authoritative Antigravity context limit. Configure an exact model override in Hermes if native metadata is missing. A positive integer `ANTIGRAVITY_CONTEXT_LENGTH` remains an explicit compatibility override; unset, invalid, zero and negative values defer to Hermes.

## Native `/usage` and quota CLI

When this provider is selected, Hermes' native `/usage` includes cached Antigravity account quota alongside normal session usage. The public `ProviderProfile.fetch_account_usage` hook reads **status only**, with a transport deadline of at most five seconds within Hermes' shared account-usage deadline. It never runs a quota refresh, model inference, login or credit request.

Quota shows separate five-hour and weekly meters for Gemini and Claude/GPT pools. Both windows constrain a pool. The adapter preserves the original observation timestamp, reset timestamps, cache staleness and health errors. Disabled/missing/invalid values are **unknown**, not zero; an observed zero remaining is 100% used. Stale values are retained as observations, not proof of present availability or refill. A reset timestamp is not proof that a reset occurred.

Use your Hermes runtime's Python and replace `<installed-plugin>` with the installed plugin directory shown by `hermes plugins show antigravity-oauth-plus`:

```bash
python <installed-plugin>/meter_cli.py refresh
python <installed-plugin>/meter_cli.py refresh --credits  # optional read-only credit observation
python <installed-plugin>/meter_cli.py status
python <installed-plugin>/meter_cli.py status --json
python <installed-plugin>/meter_cli.py history --json
```

Explicit refresh calls agy's metadata `/usage` command and, only with `--credits`, `/credits`. The backend accepts only successful zero-turn, zero-token metadata responses; it refuses an unexpected inference response. Status/history are local cache reads. Credits are observations, never top-ups or billing changes. No scheduler, background service, automatic polling or quota-burning job is installed.

Data is scoped to the active Hermes profile under its private `plugin-data/antigravity-oauth-plus/quota` directory. Keep account snapshots and history private; do not commit them to the repository. Data may become stale after account changes; refresh explicitly for the currently signed-in account before relying on it.

## Optional TUI widget

The compact ambient widget and details viewer are **explicitly opt-in**, separate from provider loading. A `kind: model-provider` plugin does not run a general `register(ctx)` lifecycle; the provider registers no tools, general hooks, middleware or slash commands.

Enable the widget explicitly for the active profile:

```bash
python <installed-plugin>/widget_setup.py enable
# Remove only this plugin's owned adapter:
python <installed-plugin>/widget_setup.py disable
```

Then use these commands in the Hermes TUI:

```text
/agy-plus-usage                  Toggle the compact quota dock
/agy-plus-usage refresh          Fetch a new quota observation
/agy-plus-usage details          Open detailed meters and exact reset times
/agy-plus-usage history 10       View collected observations
/agy-plus-usage alerts on        Enable dock-local low-quota warnings
/agy-plus-usage alerts off       Disable warnings
```

Each pool row shows remaining five-hour and weekly allowances **and both reset countdowns**, plus the depleted, disabled, unknown or unconfirmed window blocking availability. Details show exact reset timestamps. `due!` means a reset deadline passed, not that a refill was confirmed.

Warnings are opt-in, use a fixed 10% threshold, and fire only when a new healthy, fresh observation crosses from above 10% to at most 10%. They are deduplicated per meter, suppressed for stale/error data, and cleared when the dock closes. They do not send desktop notifications or start a collector. While open, the dock rereads cached status every 60 seconds; only explicit refresh contacts the backend.

The adapter adds only `/agy-plus-usage` and `/agy-plus-usage-details`, without replacing existing command names or modifying Hermes core. Native `/usage` works without the widget. Setup refuses to overwrite foreign or modified adapters; removal deletes only its validated owned file. Restart the TUI or use `/widgets-reload` if the new commands have not appeared.

## Read-only diagnostics and explicit model-catalog changes

```bash
python <installed-plugin>/diagnostics.py status --json
python <installed-plugin>/diagnostics.py status --model EXACT --effort high
python <installed-plugin>/diagnostics.py refresh-models --model EXACT --json
```

`status` is local/cached: no agy subprocess, auth probe, inference, route change or network-capable context probe. It shows the requested model and the inherited resolver's exact executable model ID, requested versus executable effort, plugin version, cached agy version, context source, separate compression settings, and catalog age/freshness. If the configured provider is not this fork (or one of its aliases), **`--model` is required**; diagnostics never resolves or queries that other provider. Exact model input is validated, not silently trimmed or repaired.

Context provenance distinguishes a positive explicit environment override, `model.context_length` for this configured provider, and an explicit per-model `model_overrides` entry. Otherwise it uses only public cache-only Hermes helpers and reports `native-resolution/source-unspecified`. **This is a partial offline view, not the complete network-capable runtime resolution chain.** A native numeric result may be a cached/default value; it is labeled unverified, not an authoritative vendor limit or verified fallback. Missing context is `null`/unknown with an explicit warning. The configured compression ratio/token cap are shown separately; the active effective threshold is unknown because runtime output reservation, small-window/minimum floors and auxiliary-model feasibility ceilings are not available to this standalone command.

Only `refresh-models` runs the official `agy models` metadata listing (10-second deadline) and an optional `agy --version` metadata probe (3-second deadline). It stores sanitized **exact CLI IDs**, never display labels or raw stdout/stderr, in the active profile's private `plugin-data/antigravity-oauth-plus/model-catalog.json` (private directory/file modes on POSIX). The first successful observation establishes a baseline; **added/removed IDs are reported only between two successful complete observations**. Failed, timed-out, empty, oversized or unrecognized/partial output leaves the prior successful snapshot unchanged and reports failure, never false removals. The conservative parser may reject a future CLI format; that is a refresh failure, not a new empty catalog. A one-hour age policy marks catalog data stale; neither a fresh listing nor a cached version proves current inference entitlement. A version probe failure may retain an older cached agy version.

JSON output is already the sanitized bug-report export: it includes only allowlisted diagnostics, model IDs and catalog changes, not full configuration, environment, token files, account history, user paths, endpoint URLs, raw command output or credentials. There is no separate report collector or upload. Refresh serializes writers with a private lock; an interrupted process can leave a lock and subsequent refresh reports `CATALOG_REFRESH_BUSY` rather than guessing the lock is safe to remove.

## Authentication and security disclosure

- `hermes auth add antigravity-oauth-plus` delegates to agy's interactive Google sign-in, then verifies with `agy models`. The inherited login command includes a one-word model prompt and may consume subscription quota after sign-in; it is not a quota-only operation. Unattended/non-TTY sign-in fails rather than waiting for user input.
- `hermes auth status antigravity-oauth-plus` and `hermes auth refresh antigravity-oauth-plus` perform a live `agy models` check. `hermes auth logout antigravity-oauth-plus` explains agy's `/logout`; Hermes does not delete the vendor credential store.
- **Inherited credential transport:** inference uses an isolated HOME/private workspace. When agy uses a token file (`jetski-standalone-oauth-token` or the legacy `antigravity-oauth-token`), `process.py` first symlinks it, then tries a hardlink, then falls back to `shutil.copy2`. Therefore this plugin **can read/copy credential bytes** through that copy fallback. It does not parse the token, save it in Hermes `auth.json`, or implement a separate OAuth client. The upstream absolute “never copies” claim does not describe this code.
- On macOS the inference transport also symlinks the user's `~/Library/Keychains` into the isolated HOME. OS keyring existence probes use `security`, `secret-tool` or `cmdkey`; those probes check presence, not secret values. The inherited transport is unchanged in this fork; a catalog maintainer must explicitly review this third-party credential access and any possible vendor writes through shared links.
- Official agy owns model/network calls. Explicit quota refresh uses the same authenticated vendor CLI; the Python status adapter uses a bounded argv-only local Node process. This fork adds no telemetry, token copying, credential migration, private-endpoint client, billing action or approval bypass beyond the disclosed inherited transport.
- Hermes remains responsible for host-tool approvals. The inherited bridge blocks agy's native tools or maps recognized requests to Hermes tools; it does not enable `--dangerously-skip-permissions`. Hermes system/SOUL rules are delivered in agy's isolated workspace.

Review the vendor's current service terms and account policies. An MIT license or a Hermes catalog listing would not imply Google authorization or guarantee account safety. See [SECURITY.md](SECURITY.md) for admission/release checks and the credential-transport concern.

## Configuration

| Setting | Behavior |
|---|---|
| `ANTIGRAVITY_COMMAND`, `AGY_CLI_PATH`, `ANTIGRAVITY_CLI_PATH` | Explicit official agy executable path; otherwise executable discovery |
| `ANTIGRAVITY_CONTEXT_LENGTH` | Optional positive integer compatibility override; no default |
| `ANTIGRAVITY_WORKSPACE_RULES` | `0` sends system/SOUL rules inline instead of workspace `GEMINI.md` |
| `ANTIGRAVITY_CONFIG_DIR` | Explicit agy credential directory; see inherited transport disclosure |

These settings do not change vendor entitlements. Keep secrets with the official CLI, not in plugin metadata or example configuration.

## Development and release policy

Run each Python fixture script with an isolated empty Hermes home and the target Hermes checkout on `PYTHONPATH`:

```bash
export HERMES_HOME="$(pwd)/.test-home"
export PYTHONPATH="<hermes-agent-checkout>:."
for test in tests/test_*.py; do python "$test" || exit; done
node --test backend/test/*.test.mjs tests/usage_widget*.test.mjs
hermes plugins validate . --install-deps --json
```

Tests use synthetic fixtures, not live credentials or paid model turns. The GitHub workflow is **verification only**, pinned to the Hermes revision above, with read-only repository permissions. It does not publish to npm, create tags or GitHub releases, or authenticate to Google. Hosted CI is distinct from local fixture verification.

Releases and catalog PRs are manual, owner-reviewed operations. Catalog entries must pin the final full SHA, quote version `"0.2.0"`, and declare empty tools/hooks/middleware/env requirements for this provider. Optional widget setup is not a provider-registered capability. Run the admission security scanner on the final integrated tree and disclose the inherited credential fallback in the PR; a passing scanner does not decide the credential trust-tier question.

## Credits and license

MIT; all upstream notices are preserved in [LICENSE](LICENSE).

- [neerazz/hermes-antigravity-oauth](https://github.com/neerazz/hermes-antigravity-oauth), © 2026 Neeraj Kumar Singh Beshane: upstream auth handler, SOUL delivery and native-tool bridge.
- [soyelmismo/hermes-antigravity-subscription](https://github.com/soyelmismo/hermes-antigravity-subscription) at `b7ab470`, © 2026 soyelmismo: streaming client, process isolation and keyring probes.
- © 2026 taylorwtf: quota backend and optional usage widget.
- © 2026 taylorwtf: OAuth Plus provider integration and fork release metadata.
