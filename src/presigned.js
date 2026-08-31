const fs = require("node:fs");

const MIN_EXPIRY_SECONDS = 60;
const MAX_EXPIRY_SECONDS = 3600;

function parseExpirySeconds(value) {
  const expiry = Number(value || 900);

  if (!Number.isInteger(expiry) || expiry < MIN_EXPIRY_SECONDS || expiry > MAX_EXPIRY_SECONDS) {
    throw new Error(
      `expiry-seconds must be an integer from ${MIN_EXPIRY_SECONDS} through ${MAX_EXPIRY_SECONDS}.`,
    );
  }

  return expiry;
}

function encodeUploadToken(url) {
  return Buffer.from(url, "utf8").toString("base64url");
}

function decodeUploadToken(token) {
  if (!/^[A-Za-z0-9_-]+$/.test(token || "")) {
    throw new Error("presigned-upload-token is not valid base64url data.");
  }

  const url = Buffer.from(token, "base64url").toString("utf8");
  const parsed = new URL(url);

  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error("The presigned upload URL must use HTTPS.");
  }

  return url;
}

async function putPresignedFile(url, file, size, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: "PUT",
    body: fs.createReadStream(file),
    duplex: "half",
    redirect: "error",
    headers: { "content-length": String(size) },
  });

  if (!response.ok) {
    throw new Error(`Presigned artifact upload failed with HTTP ${response.status}.`);
  }
}

module.exports = {
  MAX_EXPIRY_SECONDS,
  MIN_EXPIRY_SECONDS,
  decodeUploadToken,
  encodeUploadToken,
  parseExpirySeconds,
  putPresignedFile,
};
