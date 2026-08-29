const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pipeline } = require("node:stream/promises");

const core = require("@actions/core");
const { GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const { r2Config, runPrefix, assertSafeName } = require("./r2");

async function run() {
  const name = assertSafeName(core.getInput("name", { required: true }));
  const destination = core.getInput("path") || name;
  // Defaults to this run, but a caller can pull an artifact from an earlier run.
  const prefixInput = core.getInput("run-prefix");
  const prefix = prefixInput ? prefixInput.replace(/^\/+|\/+$/g, "") : runPrefix();

  const { bucket, client } = r2Config();
  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/${name}` }),
  );
  const objects = (listed.Contents || []).filter((entry) => entry.Key);

  if (objects.length === 0) {
    throw new Error(`No artifact named "${name}" under ${prefix}.`);
  }

  fs.mkdirSync(destination, { recursive: true });

  for (const object of objects) {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
    const isArchive = object.Key.endsWith(".tar.gz");
    const target = path.join(destination, path.basename(object.Key));

    await pipeline(response.Body, fs.createWriteStream(target));

    if (isArchive) {
      execFileSync("tar", ["-xzf", target, "-C", destination], { stdio: "inherit" });
      fs.rmSync(target);
    }

    core.info(`Downloaded ${object.Key}`);
  }

  core.setOutput("download-path", path.resolve(destination));
}

run().catch((error) => core.setFailed(error.message));
