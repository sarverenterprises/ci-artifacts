const { S3Client } = require("@aws-sdk/client-s3");

const REQUIRED = ["R2_CI_ACCESS_KEY_ID", "R2_CI_SECRET_ACCESS_KEY", "R2_CI_ENDPOINT", "R2_CI_BUCKET"];

/**
 * Build the S3 client and bucket name from the organization-level R2 settings.
 * Region is "auto" because R2 has no regions; the endpoint selects the account.
 */
function r2Config(env = process.env) {
  const missing = REQUIRED.filter((name) => !env[name] || !env[name].trim());

  if (missing.length) {
    throw new Error(
      `Missing required R2 configuration: ${missing.join(", ")}. ` +
        "Set the organization secrets R2_CI_ACCESS_KEY_ID and R2_CI_SECRET_ACCESS_KEY, " +
        "and the organization variables R2_CI_ENDPOINT and R2_CI_BUCKET.",
    );
  }

  return {
    bucket: env.R2_CI_BUCKET.trim(),
    client: new S3Client({
      region: "auto",
      endpoint: env.R2_CI_ENDPOINT.trim(),
      credentials: {
        accessKeyId: env.R2_CI_ACCESS_KEY_ID.trim(),
        secretAccessKey: env.R2_CI_SECRET_ACCESS_KEY.trim(),
      },
    }),
  };
}

/**
 * Object key prefix for one run attempt.
 *
 * The attempt number is part of the key so that re-running a workflow does not
 * overwrite the evidence produced by the original attempt.
 *
 * `root` replaces the repository segment. Bucket lifecycle rules match on a key
 * prefix, so an artifact that needs its own retention -- a released build kept
 * for a year next to throwaway PR bundles -- must not share the default root.
 */
function runPrefix(env = process.env, root = "") {
  const repo = (env.GITHUB_REPOSITORY || "").split("/")[1];
  const runId = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT || "1";

  if (!repo || !runId) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_RUN_ID must be set; this action only runs inside GitHub Actions.");
  }

  return `${root || repo}/${runId}/${attempt}`;
}

/**
 * Artifact names reach an object key, so reject anything that could escape the
 * run prefix or produce an ambiguous key.
 */
function assertSafeName(name) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) {
    throw new Error(
      `Invalid artifact name "${name}". Use 1-128 letters, numbers, dots, underscores, or hyphens.`,
    );
  }

  if (name === "." || name === "..") {
    throw new Error(`Invalid artifact name "${name}".`);
  }

  return name;
}

module.exports = { r2Config, runPrefix, assertSafeName };
