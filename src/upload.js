const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const os = require("node:os");

const core = require("@actions/core");
const glob = require("@actions/glob");
const { PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const { r2Config, runPrefix, assertSafeName } = require("./r2");

// SigV4 caps presigned URL lifetime at seven days. Longer-lived artifacts are
// still in the bucket; they just need a freshly signed link.
const MAX_PRESIGN_SECONDS = 604800;

async function resolveFiles(pattern) {
  const globber = await glob.create(pattern, { matchDirectories: false });

  return globber.glob();
}

/**
 * Deepest directory containing every matched file.
 *
 * A multi-line pattern produces several search paths, so taking the first one
 * would put "../" segments into the archive. The common ancestor keeps every
 * stored path relative and inside the archive.
 */
function commonRoot(files) {
  const split = files.map((file) => path.dirname(path.resolve(file)).split(path.sep));
  const shared = split.reduce((acc, parts) => {
    const limit = Math.min(acc.length, parts.length);
    let i = 0;

    while (i < limit && acc[i] === parts[i]) {
      i += 1;
    }

    return acc.slice(0, i);
  });

  return shared.join(path.sep) || path.sep;
}

/**
 * Root the archive at a directory the caller named outright.
 *
 * actions/upload-artifact uses the given path as the archive root. commonRoot
 * would instead pick the deepest shared ancestor, so a `blog/dist` whose files
 * all sit under `_astro/` would silently lose that directory on extraction.
 */
function resolveRoot(pattern, files) {
  const lines = pattern.split("\n").map((line) => line.trim()).filter(Boolean);

  if (lines.length === 1 && !/[*?[\]!]/.test(lines[0])) {
    const resolved = path.resolve(lines[0]);

    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return { root: resolved, declaredDirectory: true };
    }
  }

  return { root: commonRoot(files), declaredDirectory: false };
}

/**
 * A single file is uploaded as-is so its link downloads the real artifact --
 * an APK stays an APK. Multiple files are tarred so one artifact is one object.
 *
 * A named directory is always archived, even when it holds exactly one file,
 * because storing that file raw would drop the path it sits at.
 */
function buildPayload(files, root, name, declaredDirectory) {
  if (!declaredDirectory && files.length === 1 && fs.statSync(files[0]).isFile()) {
    return { body: files[0], key: `${name}/${path.basename(files[0])}`, archived: false };
  }

  const archive = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ci-artifact-")), `${name}.tar.gz`);
  const relative = files.map((file) => path.relative(root, path.resolve(file)));

  // tar ships on every supported runner, so this needs no bundled zip library.
  execFileSync("tar", ["-czf", archive, "-C", root, "--", ...relative], { stdio: "inherit" });

  return { body: archive, key: `${name}.tar.gz`, archived: true };
}

async function run() {
  const name = assertSafeName(core.getInput("name", { required: true }));
  const pattern = core.getInput("path", { required: true });
  const ifNoFilesFound = core.getInput("if-no-files-found") || "warn";
  const expiry = Math.min(Number(core.getInput("link-expiry-seconds") || 604800), MAX_PRESIGN_SECONDS);
  // Validated like an artifact name because it reaches an object key too.
  const keyPrefixInput = core.getInput("key-prefix");
  const keyPrefix = keyPrefixInput ? assertSafeName(keyPrefixInput.trim()) : "";

  const files = await resolveFiles(pattern);

  if (files.length === 0) {
    const message = `No files matched "${pattern}".`;

    if (ifNoFilesFound === "error") {
      throw new Error(message);
    }
    if (ifNoFilesFound === "warn") {
      core.warning(message);
    }
    return;
  }

  const { bucket, client } = r2Config();
  const { root, declaredDirectory } = resolveRoot(pattern, files);
  const { body, key, archived } = buildPayload(files, root, name, declaredDirectory);
  const objectKey = `${runPrefix(process.env, keyPrefix)}/${key}`;
  const size = fs.statSync(body).size;

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: fs.createReadStream(body),
      ContentLength: size,
    }),
  );

  const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: objectKey }), {
    expiresIn: expiry,
  });

  core.setOutput("object-key", objectKey);
  core.setOutput("url", url);
  core.setOutput("size", String(size));

  const megabytes = (size / 1048576).toFixed(1);
  const detail = archived ? `${files.length} files, tar.gz` : path.basename(files[0]);

  core.info(`Uploaded ${objectKey} (${megabytes} MB)`);
  await core.summary
    .addRaw(`**Artifact \`${name}\`** — [download](${url}) · ${megabytes} MB · ${detail}\n\n`)
    .write();
}

run().catch((error) => core.setFailed(error.message));
