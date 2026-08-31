const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const { encodeUploadToken } = require("../src/presigned");
const { extractTarGzSafely } = require("../src/archive");

test("upload action sends a directory through a scoped URL without R2 credentials", async (t) => {
  let uploaded = Buffer.alloc(0);
  const server = http.createServer((request, response) => {
    assert.equal(request.method, "PUT");
    assert.equal(request.url, "/one-object");
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      uploaded = Buffer.concat(chunks);
      response.writeHead(200);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ci-artifact-action-test-"));
  const dist = path.join(work, "dist");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<h1>Journal</h1>");
  fs.writeFileSync(path.join(dist, "assets/app.css"), "body{}\n");
  const output = path.join(work, "output.txt");
  const summary = path.join(work, "summary.md");
  fs.writeFileSync(output, "");
  fs.writeFileSync(summary, "");

  const port = server.address().port;
  const objectKey = "demo/42/1/candidate-build.tar.gz";
  const child = spawn(process.execPath, [path.resolve("upload/dist/index.js")], {
    cwd: work,
    env: {
      ...process.env,
      GITHUB_REPOSITORY: "sarverenterprises/demo",
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      INPUT_NAME: "candidate-build",
      INPUT_PATH: dist,
      "INPUT_IF-NO-FILES-FOUND": "error",
      "INPUT_PRESIGNED-UPLOAD-TOKEN": encodeUploadToken(`http://127.0.0.1:${port}/one-object`),
      "INPUT_EXPECTED-OBJECT-KEY": objectKey,
      R2_CI_ACCESS_KEY_ID: "",
      R2_CI_SECRET_ACCESS_KEY: "",
      R2_CI_ENDPOINT: "",
      R2_CI_BUCKET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(exitCode, 0, stderr);
  assert.ok(uploaded.length > 0, "the scoped endpoint must receive the archive");
  assert.equal(uploaded[0], 0x1f);
  assert.equal(uploaded[1], 0x8b);
  assert.match(fs.readFileSync(output, "utf8"), new RegExp(`object-key<<[^\n]+\n${objectKey}`));

  const received = path.join(work, "received.tar.gz");
  const extracted = path.join(work, "received");
  fs.writeFileSync(received, uploaded);
  await extractTarGzSafely(received, extracted, { allowedRoot: work, replaceExisting: true });
  assert.equal(fs.readFileSync(path.join(extracted, "index.html"), "utf8"), "<h1>Journal</h1>");
  assert.equal(fs.readFileSync(path.join(extracted, "assets/app.css"), "utf8"), "body{}\n");
});
