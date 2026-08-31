const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pipeline } = require("node:stream/promises");

const core = require("@actions/core");
const { GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const { extractTarGzSafely } = require("./archive");
const { r2Config, runPrefix, assertSafeName } = require("./r2");

async function run() {
  const name = assertSafeName(core.getInput("name", { required: true }));
  const destination = core.getInput("path") || name;
  const replaceExisting = core.getBooleanInput("replace-existing");
  // Defaults to this run, but a caller can pull an artifact from an earlier run.
  const prefixInput = core.getInput("run-prefix");
  const prefix = prefixInput ? prefixInput.replace(/^\/+|\/+$/g, "") : runPrefix();

  const { bucket, client } = r2Config();
  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/${name}` }),
  );
  const archiveKey = `${prefix}/${name}.tar.gz`;
  const rawPrefix = `${prefix}/${name}/`;
  const objects = (listed.Contents || []).filter(
    (entry) => entry.Key === archiveKey || entry.Key?.startsWith(rawPrefix),
  );

  if (objects.length === 0) {
    throw new Error(`No artifact named "${name}" under ${prefix}.`);
  }
  if (objects.length !== 1) {
    throw new Error(`Artifact "${name}" resolved to ${objects.length} objects; expected exactly one.`);
  }

  for (const object of objects) {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
    const isArchive = object.Key.endsWith(".tar.gz");
    const temporaryDirectory = isArchive ? fs.mkdtempSync(path.join(os.tmpdir(), "ci-artifact-download-")) : null;
    const target = isArchive
      ? path.join(temporaryDirectory, path.basename(object.Key))
      : path.join(destination, path.basename(object.Key));

    if (!isArchive) fs.mkdirSync(destination, { recursive: true });

    try {
      await pipeline(response.Body, fs.createWriteStream(target, { flags: "wx" }));

      if (isArchive) {
        const extracted = await extractTarGzSafely(target, destination, { replaceExisting });
        core.info(`Validated ${extracted.members} archive members (${extracted.expandedBytes} expanded bytes).`);
      }
    } finally {
      if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }

    core.info(`Downloaded ${object.Key}`);
  }

  core.setOutput("download-path", path.resolve(destination));
}

run().catch((error) => core.setFailed(error.message));
