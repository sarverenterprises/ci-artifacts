const core = require("@actions/core");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const { encodeUploadToken, parseExpirySeconds } = require("./presigned");
const { assertSafeName, r2Config, runPrefix } = require("./r2");

async function run() {
  const name = assertSafeName(core.getInput("name", { required: true }));
  const expiry = parseExpirySeconds(core.getInput("expiry-seconds"));
  const keyPrefixInput = core.getInput("key-prefix");
  const keyPrefix = keyPrefixInput ? assertSafeName(keyPrefixInput.trim()) : "";
  const objectKey = `${runPrefix(process.env, keyPrefix)}/${name}.tar.gz`;
  const { bucket, client } = r2Config();
  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: objectKey }),
    { expiresIn: expiry },
  );

  // The base64url token avoids GitHub suppressing the job output because the
  // SigV4 URL contains the configured access-key ID. It still grants only a
  // short-lived PUT to this exact object key.
  core.setOutput("upload-token", encodeUploadToken(uploadUrl));
  core.setOutput("object-key", objectKey);
  core.info(`Authorized one upload to ${objectKey} for ${expiry} seconds.`);
}

run().catch((error) => core.setFailed(error.message));
