// Exercises the bundled actions against a local S3-compatible server: upload a
// multi-file artifact and a single-file artifact, then download both back.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");
const { S3Client, CreateBucketCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const ENDPOINT = "http://127.0.0.1:9111";
const BUCKET = "ci-artifacts-test";

const env = (extra) => ({
  ...process.env,
  R2_CI_ACCESS_KEY_ID: "testkey",
  R2_CI_SECRET_ACCESS_KEY: "testsecret123",
  R2_CI_ENDPOINT: ENDPOINT,
  R2_CI_BUCKET: BUCKET,
  AWS_EC2_METADATA_DISABLED: "true",
  GITHUB_REPOSITORY: "sarverenterprises/demo",
  GITHUB_RUN_ID: "7777",
  GITHUB_RUN_ATTEMPT: "3",
  GITHUB_STEP_SUMMARY: path.join(os.tmpdir(), "summary.md"),
  GITHUB_OUTPUT: path.join(os.tmpdir(), "outputs.txt"),
  ...extra,
});

(async () => {
  const client = new S3Client({
    region: "auto", endpoint: ENDPOINT, forcePathStyle: true,
    credentials: { accessKeyId: "testkey", secretAccessKey: "testsecret123" },
  });
  try { await client.send(new CreateBucketCommand({ Bucket: BUCKET })); } catch {}

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
  fs.mkdirSync(path.join(work, "reports/nested"), { recursive: true });
  fs.writeFileSync(path.join(work, "reports/a.json"), '{"a":1}');
  fs.writeFileSync(path.join(work, "reports/nested/b.json"), '{"b":2}');
  fs.writeFileSync(path.join(work, "app.apk"), Buffer.alloc(1024 * 512, 7));
  // Every file sits under one subdirectory. The archive root must still be the
  // named directory, or "_astro" is flattened away on extraction.
  fs.mkdirSync(path.join(work, "dist/_astro"), { recursive: true });
  fs.writeFileSync(path.join(work, "dist/_astro/app.js"), "console.log(1)");
  // A named directory holding exactly one file must still be archived, not
  // stored raw, so the path it sits at survives.
  fs.mkdirSync(path.join(work, "solo/deep"), { recursive: true });
  fs.writeFileSync(path.join(work, "solo/deep/only.txt"), "one");

  // The runner pre-creates these files; @actions/core appends and does not create.
  for (const f of [env().GITHUB_STEP_SUMMARY, env().GITHUB_OUTPUT]) fs.writeFileSync(f, "");

  const run = (script, extra) =>
    execFileSync("node", [script], { env: env(extra), encoding: "utf8", cwd: work });

  // 1. Multi-file artifact -> tar.gz
  run("/tmp/ci-artifacts/upload/dist/index.js", {
    INPUT_NAME: "reports", INPUT_PATH: path.join(work, "reports"), "INPUT_IF-NO-FILES-FOUND": "error",
  });
  // 2. Single file -> stored raw so the link downloads a real .apk
  run("/tmp/ci-artifacts/upload/dist/index.js", {
    INPUT_NAME: "android-apk", INPUT_PATH: path.join(work, "app.apk"), "INPUT_IF-NO-FILES-FOUND": "error",
  });

  // 3. Directory whose files all live in one subdirectory
  run("/tmp/ci-artifacts/upload/dist/index.js", {
    INPUT_NAME: "blog-dist", INPUT_PATH: path.join(work, "dist"), "INPUT_IF-NO-FILES-FOUND": "error",
  });
  // 4. Named directory holding a single file
  run("/tmp/ci-artifacts/upload/dist/index.js", {
    INPUT_NAME: "solo", INPUT_PATH: path.join(work, "solo"), "INPUT_IF-NO-FILES-FOUND": "error",
  });

  // 5. key-prefix moves the object to its own root so a bucket lifecycle rule
  //    can retain it separately from the throwaway artifacts above.
  run("/tmp/ci-artifacts/upload/dist/index.js", {
    INPUT_NAME: "release-bundle", INPUT_PATH: path.join(work, "dist"),
    "INPUT_IF-NO-FILES-FOUND": "error", "INPUT_KEY-PREFIX": "demo-release",
  });

  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "dl-"));
  run("/tmp/ci-artifacts/download/dist/index.js", {
    INPUT_NAME: "reports", INPUT_PATH: path.join(dest, "reports"),
  });
  run("/tmp/ci-artifacts/download/dist/index.js", {
    INPUT_NAME: "android-apk", INPUT_PATH: path.join(dest, "apk"),
  });
  run("/tmp/ci-artifacts/download/dist/index.js", {
    INPUT_NAME: "blog-dist", INPUT_PATH: path.join(dest, "blog"),
  });
  run("/tmp/ci-artifacts/download/dist/index.js", {
    INPUT_NAME: "solo", INPUT_PATH: path.join(dest, "solo"),
  });
  // The prefixed object is invisible to the default run prefix, so the consumer
  // must name the same root. That asymmetry is the point: separate retention.
  run("/tmp/ci-artifacts/download/dist/index.js", {
    INPUT_NAME: "release-bundle", INPUT_PATH: path.join(dest, "release"),
    "INPUT_RUN-PREFIX": "demo-release/7777/3",
  });

  assert.equal(fs.readFileSync(path.join(dest, "reports/a.json"), "utf8"), '{"a":1}');
  assert.equal(fs.readFileSync(path.join(dest, "reports/nested/b.json"), "utf8"), '{"b":2}');
  assert.equal(fs.statSync(path.join(dest, "apk/app.apk")).size, 1024 * 512);
  assert.ok(!fs.existsSync(path.join(dest, "reports/reports.tar.gz")), "archive should be removed after extraction");
  assert.equal(fs.readFileSync(path.join(dest, "blog/_astro/app.js"), "utf8"), "console.log(1)");
  assert.equal(fs.readFileSync(path.join(dest, "solo/deep/only.txt"), "utf8"), "one");

  assert.equal(fs.readFileSync(path.join(dest, "release/_astro/app.js"), "utf8"), "console.log(1)");
  // Nothing leaked into the default root under the release name.
  const stray = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "demo/7777/3/release-bundle" }));
  assert.equal(stray.KeyCount || 0, 0, "key-prefix artifact must not also land under the repository root");
  const placed = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "demo-release/7777/3/" }));
  assert.ok((placed.KeyCount || 0) > 0, "key-prefix artifact must land under its own root");

  const summary = fs.readFileSync(env().GITHUB_STEP_SUMMARY, "utf8");
  assert.match(summary, /Artifact `reports`.*download.*0\.0 MB.*2 files, tar\.gz/);
  assert.match(summary, /Artifact `android-apk`.*download.*0\.5 MB.*app\.apk/);

  console.log("E2E PASS: nested tree round-tripped, named directory root preserved, single file stored raw, summary links written");
})();
