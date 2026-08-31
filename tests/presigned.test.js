const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  decodeUploadToken,
  encodeUploadToken,
  parseExpirySeconds,
  putPresignedFile,
} = require("../src/presigned");

test("presigned upload expiry is short and bounded", () => {
  assert.equal(parseExpirySeconds(""), 900);
  assert.equal(parseExpirySeconds("60"), 60);
  assert.equal(parseExpirySeconds("3600"), 3600);
  for (const value of ["59", "3601", "1.5", "nope"]) {
    assert.throws(() => parseExpirySeconds(value), /expiry-seconds/);
  }
});

test("upload tokens round-trip without exposing the credential text in plain form", () => {
  const url = "https://account.example/upload?X-Amz-Credential=key&X-Amz-Signature=sig";
  const token = encodeUploadToken(url);

  assert.doesNotMatch(token, /Credential|Signature|key/);
  assert.equal(decodeUploadToken(token), url);
  assert.throws(() => decodeUploadToken("not+base64"), /base64url/);
  assert.throws(
    () => decodeUploadToken(encodeUploadToken("http://example.com/upload")),
    /must use HTTPS/,
  );
});

test("presigned upload sends the file once and rejects redirects or failures", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ci-artifact-test-")), "bundle.tar.gz");
  fs.writeFileSync(file, "candidate-static-build");
  let request;
  const okFetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200 };
  };

  await putPresignedFile("https://r2.example/upload", file, 22, okFetch);
  assert.equal(request.url, "https://r2.example/upload");
  assert.equal(request.options.method, "PUT");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers["content-length"], "22");
  assert.equal(request.options.duplex, "half");

  await assert.rejects(
    putPresignedFile("https://r2.example/upload", file, 22, async () => ({ ok: false, status: 403 })),
    /HTTP 403/,
  );
});
