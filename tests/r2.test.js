const assert = require("node:assert/strict");
const test = require("node:test");

const { r2Config, runPrefix, assertSafeName } = require("../src/r2");

const ENV = {
  R2_CI_ACCESS_KEY_ID: "key",
  R2_CI_SECRET_ACCESS_KEY: "secret",
  R2_CI_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  R2_CI_BUCKET: "sarvent-ci-artifacts",
};

test("r2Config names every missing setting at once", () => {
  assert.throws(() => r2Config({}), /R2_CI_ACCESS_KEY_ID, R2_CI_SECRET_ACCESS_KEY, R2_CI_ENDPOINT, R2_CI_BUCKET/);
  assert.throws(() => r2Config({ ...ENV, R2_CI_BUCKET: "   " }), /R2_CI_BUCKET/);
});

test("r2Config builds a bucket-scoped client", async () => {
  const { bucket, client } = r2Config(ENV);

  assert.equal(bucket, "sarvent-ci-artifacts");
  // R2 has no regions; the endpoint selects the account.
  assert.equal(await client.config.region(), "auto");
  assert.equal((await client.config.endpoint()).hostname, "account.r2.cloudflarestorage.com");
});

test("runPrefix separates run attempts so a re-run cannot overwrite evidence", () => {
  const base = { GITHUB_REPOSITORY: "sarverenterprises/morningshepherd", GITHUB_RUN_ID: "42" };

  assert.equal(runPrefix({ ...base, GITHUB_RUN_ATTEMPT: "1" }), "morningshepherd/42/1");
  assert.equal(runPrefix({ ...base, GITHUB_RUN_ATTEMPT: "2" }), "morningshepherd/42/2");
  assert.equal(runPrefix(base), "morningshepherd/42/1");
});

test("runPrefix refuses to run outside GitHub Actions", () => {
  assert.throws(() => runPrefix({}), /only runs inside GitHub Actions/);
  assert.throws(() => runPrefix({ GITHUB_REPOSITORY: "sarverenterprises/x" }), /only runs inside GitHub Actions/);
});

test("artifact names cannot escape the run prefix", () => {
  for (const name of ["../../etc/passwd", "a/b", "with space", "", "x".repeat(129), "..", "sha:1"]) {
    assert.throws(() => assertSafeName(name), /Invalid artifact name/, `accepted ${JSON.stringify(name)}`);
  }

  for (const name of ["android-apk", "report.tar.gz", "bundle_1", "x".repeat(128)]) {
    assert.equal(assertSafeName(name), name);
  }
});
