# Streamient Sync

Synchronize Markdown, Canvas, Bases, documents, and attachments between one Obsidian vault and multiple hosted or self-hosted Streamient projects. The plugin runs inside Obsidian; nothing is installed on the Streamient server.

## Features

- Two-way synchronization on desktop and mobile.
- Multiple Streamient projects and OAuth accounts in one vault.
- Per-project Off, selected folders/files, or entire-vault scope for extra vault content.
- Reviewable first sync with cooperative Abort and manual Resume.
- Canonical, byte-preserved Markdown.
- Resumable encrypted attachment uploads.
- Offline queue, revision cursors, and multiple-device idempotency.
- Streamient Notes by default and opt-in Memories through `streamient_type: memory` frontmatter.
- Saved URLs under each project's `URLs` folder, with URL, title, tags, and description round-tripping as Markdown.
- Obsidian trash integration and recoverable conflict revisions.

## Installation

Streamient Sync requires Obsidian 1.13.0 or newer.

### Obsidian Community Plugins

1. Open **Settings → Community plugins** in Obsidian.
2. Select **Browse** and search for **Streamient Sync**.
3. Select **Install**, then **Enable**.

[Open Streamient Sync in the Obsidian Community directory](https://community.obsidian.md/plugins/streamient-sync).

### Prereleases with BRAT

To test prerelease builds, install [BRAT](https://obsidian.md/plugins?id=obsidian42-brat), add `https://github.com/streamient/streamient-obsidian`, and enable **Streamient Sync**. Stable users should install from Obsidian Community Plugins.

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [releases page](https://github.com/streamient/streamient-obsidian/releases).
2. Place them in `<vault>/.obsidian/plugins/streamient-sync/`.
3. Reload Obsidian and enable **Streamient Sync** under Community plugins.

## Connect a Vault

1. Open **Settings → Streamient Sync**.
2. Enter `https://app.streamient.com` or your self-hosted Streamient URL and select **Sign in**.
3. Authorize `vault:read` and `vault:write` access. This becomes the default account.
4. Add one or more projects. Use **Add account** to authorize a separate work or personal account without signing out the default account.
5. Each project defaults to `Streamient/<Project name>`. Project-folder edits always synchronize both ways.
6. Optionally enable extra vault content for that project and choose individual files, folders, or the unassigned remainder of the vault.
7. Review transfer counts and bytes, then explicitly start the first sync.

Projects synchronize sequentially. **Abort** stops after the current request or upload chunk, removes an incomplete upload, and leaves completed work intact. The project remains paused until **Resume** is selected.

Large server-side exports continue in bounded batches, avoiding long proxy-bound requests. Use the **Move** button beside a project folder to relocate existing synchronized files in resumable batches; the plugin preserves history, removes only empty source folders, and requires review afterward.

Saved URLs use `streamient_type: url` plus a `url` field in frontmatter. The Markdown body is the saved description. Streamient keeps extracted and crawled page text server-side, so vault edits cannot overwrite crawler output. See the [Streamient Obsidian Sync guide](https://docs.streamient.com/guide/obsidian-sync) for the complete format.

## Privacy and network disclosure

Streamient Sync requires a Streamient account and connects only to the configured Streamient server. The plugin enumerates only managed project folders and optional vault content assigned to each project. Vault content is sent over TLS in server-readable form so Streamient can index, preview, and edit it. The Streamient server encrypts synchronized files at rest. Every OAuth account has a separate refresh credential in Obsidian SecretStorage. The plugin contains no advertising, analytics, or telemetry.

The plugin excludes `.obsidian`, `.git`, `.trash`, other dot-folders, OS metadata, and temporary files.
