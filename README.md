# Streamient Sync

Synchronize Markdown, Canvas, Bases, documents, and attachments between an Obsidian vault and a hosted or self-hosted Streamient project. The plugin runs inside Obsidian; nothing is installed on the Streamient server.

## Features

- Two-way synchronization on desktop and mobile.
- Canonical, byte-preserved Markdown.
- Resumable encrypted attachment uploads.
- Offline queue, revision cursors, and multiple-device idempotency.
- Streamient Notes by default and opt-in Memories through `streamient_type: memory` frontmatter.
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
3. Authorize `vault:read` and `vault:write` access.
4. Choose a project, review the first-sync preview, and start synchronization.

## Privacy and network disclosure

Streamient Sync requires a Streamient account and connects only to the configured Streamient server. To provide full-vault synchronization, the plugin enumerates all user-visible vault files before applying the exclusions below. Vault content is sent over TLS in server-readable form so Streamient can index, preview, and edit it. The Streamient server encrypts synchronized files at rest. OAuth refresh credentials use Obsidian SecretStorage. The plugin contains no advertising, analytics, or telemetry.

The plugin excludes `.obsidian`, `.git`, `.trash`, other dot-folders, OS metadata, and temporary files.
