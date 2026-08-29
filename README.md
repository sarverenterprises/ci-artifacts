# ci-artifacts

Upload and download GitHub Actions artifacts using the shared Cloudflare R2
bucket instead of GitHub artifact storage.

## Why

GitHub artifact storage is a billed, account-wide quota. Unlike the Actions
cache, artifacts are **never evicted** — they persist until `retention-days`
expires them. When the quota fills, uploads hard-fail in *every* repository in
the organization, including repositories that store almost nothing:

```
##[error]Failed to CreateArtifact: Artifact storage quota has been hit.
```

R2 has no such quota. Retention is enforced by bucket lifecycle rules.

## Usage

```yaml
- uses: sarverenterprises/ci-artifacts/upload@v1
  with:
    name: android-apk
    path: apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

```yaml
- uses: sarverenterprises/ci-artifacts/download@v1
  with:
    name: android-apk
    path: ./downloaded
```

`path` accepts a file, a directory, or a glob, with the same matching rules as
`actions/upload-artifact`.

### Inputs — `upload`

| Input | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | — | 1-128 letters, numbers, dots, underscores, hyphens |
| `path` | yes | — | File, directory, or glob |
| `if-no-files-found` | no | `warn` | `warn`, `error`, or `ignore` |
| `link-expiry-seconds` | no | `604800` | Presigned link lifetime, capped at 7 days |

Outputs: `object-key`, `url`, `size`.

### Inputs — `download`

| Input | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | — | Artifact to fetch |
| `path` | no | the artifact name | Destination directory |
| `run-prefix` | no | the current run | `<repo>/<run_id>/<attempt>` to read from an earlier run |

Output: `download-path`.

## Configuration

Set once at organization level. No repository needs its own copy.

| Kind | Name |
|---|---|
| secret | `R2_CI_ACCESS_KEY_ID` |
| secret | `R2_CI_SECRET_ACCESS_KEY` |
| variable | `R2_CI_ENDPOINT` |
| variable | `R2_CI_BUCKET` |

The actions read these from the environment, so every calling job must pass
them through:

```yaml
env:
  R2_CI_ACCESS_KEY_ID: ${{ secrets.R2_CI_ACCESS_KEY_ID }}
  R2_CI_SECRET_ACCESS_KEY: ${{ secrets.R2_CI_SECRET_ACCESS_KEY }}
  R2_CI_ENDPOINT: ${{ vars.R2_CI_ENDPOINT }}
  R2_CI_BUCKET: ${{ vars.R2_CI_BUCKET }}
```

## Storage layout

```
<repo>/<run_id>/<run_attempt>/<name>/<file>      single file, stored raw
<repo>/<run_id>/<run_attempt>/<name>.tar.gz      multiple files
```

The run attempt is part of the key, so re-running a workflow cannot overwrite
the evidence from the original attempt.

A single file is stored raw rather than archived, so its download link yields
the real artifact — an APK stays an APK.

## Retention

Retention is a **bucket lifecycle rule**, not a workflow input. There is no
`retention-days`; set the rules in the Cloudflare dashboard.

## Development

```bash
npm install
npm test                    # unit tests
npm run build               # rebuild upload/dist and download/dist
node tests/e2e-roundtrip.js # requires a local S3 server on :9111
```

`upload/dist` and `download/dist` are committed build outputs. CI fails if they
drift from `src/`.
