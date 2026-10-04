# Security and catalog admission

## Boundaries

This fork uses the public Hermes model-provider lifecycle and `ProviderProfile.fetch_account_usage`. It does not patch Hermes core, mutate private registries, register general tools/hooks/middleware, install a daemon, self-update or publish automatically. Optional widget adapter setup is a separate user action.

Cached native `/usage` is bounded and local-only. Explicit quota refresh runs Google's authenticated agy metadata command; responses must report zero turns and zero tokens. Credit collection is opt-in and read-only. Missing, disabled, stale, reset-due and error states are not evidence of available quota. Profile-private observations must not enter a public release.

## Inherited credential transport: maintainer decision required

The inference implementation in `process.py` exposes agy's existing credential file to an isolated HOME. Its sequence is symlink → hardlink → `shutil.copy2`; the last fallback reads and copies secret bytes. On macOS, `~/Library/Keychains` is symlinked as well. A shared credential link can allow the vendor child to access or update the same store. This fork does not silently replace that transport or claim that it never copies credentials.

Catalog policy requires disclosure of third-party credential reads, and an explicit maintainer ruling for another client's OAuth writes/refresh. A scanner result alone cannot settle that trust-tier question. Disclose this implementation in the catalog PR and seek the maintainer's decision before representing the fork as admitted. Do not bypass a denied security scan or copy a plugin into a live profile to avoid the normal install gate.

Auth add is an interactive official-CLI operation and includes a short model prompt; it may consume subscription quota. No live authentication or inference is required by CI. The vendor's terms and account-safety policies are independent of this software's MIT license.

## Release checklist

- Merge provider and quota/widget changes and run all Python and Node fixture suites against the declared Hermes revision.
- Verify cached transport actually finishes within five seconds and never invokes agy; test an explicit refresh only with authorized synthetic fixtures unless live testing is separately approved.
- Verify opt-in widget setup/removal in an isolated profile and truthful empty provider capability declarations.
- Run `hermes plugins validate . --install-deps --json` on the final integrated tree. Retain every security finding, not just exit status; dangerous findings block release, caution findings require reviewer attention.
- Audit for core overrides, credential/config files, account snapshots, logs, private filesystem paths, token values, download-and-replace/self-updater code, telemetry, billing changes and approval bypasses.
- The legacy upstream npm installer is not the fork's installation route; package metadata is private and exposes no binary. Assess/remove legacy distribution files if admission review requires it.
- Review `process.py` credential fallback and macOS keychain exposure explicitly. Do not mark the catalog security question resolved by a fixture test.
- Pin one `plugin-catalog/antigravity-oauth-plus.yaml` entry to the final public full SHA; version is `"0.2.0"`, personal maintainer is `taylorwtf`, repo is `https://github.com/taylorwtf/hermes-antigravity-oauth`.
- No npm publishing. Tags, GitHub releases and catalog submission remain separately authorized owner operations, not CI side effects.

Report vulnerabilities privately to the repository owner through GitHub's available security-reporting channel. Never post credentials, token-file contents or account history in a public issue.
