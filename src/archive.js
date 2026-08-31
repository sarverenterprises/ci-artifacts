const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createGunzip } = require("node:zlib");

const tar = require("tar-stream");

const DEFAULT_LIMITS = Object.freeze({
  maxCompressedBytes: 256 * 1024 * 1024,
  maxDecompressedBytes: 544 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  maxMembers: 10_000,
  maxPathBytes: 1024,
});

function safeMember(header, state, limits) {
  const name = header.name;
  if (
    typeof name !== "string" ||
    !name ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    Buffer.byteLength(name) > limits.maxPathBytes
  ) {
    throw new Error(`Unsafe archive member path: ${JSON.stringify(name)}.`);
  }

  const normalized = path.posix.normalize(name);
  const segments = name.replace(/\/$/, "").split("/");
  if (
    normalized !== name ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe archive member path: ${JSON.stringify(name)}.`);
  }

  const type = header.type || "file";
  if (type !== "file" && type !== "directory") {
    throw new Error(`Archive member ${JSON.stringify(name)} has prohibited type ${JSON.stringify(type)}.`);
  }
  if (state.names.has(name)) {
    throw new Error(`Archive contains duplicate member ${JSON.stringify(name)}.`);
  }

  const size = Number(header.size || 0);
  if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes) {
    throw new Error(`Archive member ${JSON.stringify(name)} exceeds the per-file size limit.`);
  }

  state.members += 1;
  state.expandedBytes += size;
  state.names.add(name);
  if (state.members > limits.maxMembers) throw new Error("Archive exceeds the member-count limit.");
  if (state.expandedBytes > limits.maxExpandedBytes) throw new Error("Archive exceeds the expanded-size limit.");

  return { name, segments, size, type };
}

async function pathState(target) {
  try {
    return await fsp.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertRegularTree(directory) {
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await assertRegularTree(target);
    else if (!entry.isFile()) throw new Error(`Destination contains prohibited path type: ${target}.`);
  }
}

async function mergeTree(source, destination) {
  const existing = await pathState(destination);
  if (existing?.isSymbolicLink()) throw new Error("Artifact destination cannot be a symbolic link.");
  if (existing && !existing.isDirectory()) throw new Error("Artifact destination must be a directory.");
  if (existing) await assertRegularTree(destination);
  else await fsp.mkdir(destination, { recursive: true });

  for (const entry of await fsp.readdir(source)) {
    await fsp.cp(path.join(source, entry), path.join(destination, entry), {
      recursive: true,
      force: true,
    });
  }
}

function isStrictDescendant(root, target) {
  return target.startsWith(`${root}${path.sep}`);
}

async function replacementTarget(destination, allowedRoot) {
  if (!allowedRoot) throw new Error("Atomic artifact replacement requires an explicit allowed root.");
  if (String(destination).split(/[\\/]+/).includes("..")) {
    throw new Error("Atomic artifact replacement rejects destinations containing '..'.");
  }

  const requestedRoot = path.resolve(allowedRoot);
  const requestedDestination = path.resolve(destination);
  if (!isStrictDescendant(requestedRoot, requestedDestination)) {
    throw new Error(`Artifact replacement destination must be below ${requestedRoot}.`);
  }

  const realRoot = await fsp.realpath(requestedRoot);
  const parent = path.dirname(requestedDestination);
  await fsp.mkdir(parent, { recursive: true });
  const realParent = await fsp.realpath(parent);
  const resolvedDestination = path.join(realParent, path.basename(requestedDestination));
  if (!isStrictDescendant(realRoot, resolvedDestination)) {
    throw new Error(`Artifact replacement destination escaped allowed root ${realRoot}.`);
  }
  return resolvedDestination;
}

async function replaceTree(source, destination) {
  const existing = await pathState(destination);
  if (existing?.isSymbolicLink()) throw new Error("Artifact destination cannot be a symbolic link.");
  if (existing && !existing.isDirectory()) throw new Error("Artifact destination must be a directory.");

  const parent = path.dirname(destination);
  const backup = path.join(parent, `.${path.basename(destination)}.backup-${crypto.randomUUID()}`);
  let movedExisting = false;

  try {
    if (existing) {
      await fsp.rename(destination, backup);
      movedExisting = true;
    }
    await fsp.rename(source, destination);
    if (movedExisting) await fsp.rm(backup, { recursive: true });
  } catch (error) {
    if (movedExisting && !(await pathState(destination)) && await pathState(backup)) {
      await fsp.rename(backup, destination);
    }
    throw error;
  }
}

async function extractTarGzSafely(archive, destination, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const archiveSize = (await fsp.stat(archive)).size;
  if (archiveSize > limits.maxCompressedBytes) throw new Error("Archive exceeds the compressed-size limit.");

  const requestedDestination = path.resolve(destination);
  let validatedReplacement = null;
  if (options.replaceExisting) {
    validatedReplacement = await replacementTarget(destination, options.allowedRoot);
  }
  const destinationParent = path.dirname(requestedDestination);
  await fsp.mkdir(destinationParent, { recursive: true });
  const realParent = await fsp.realpath(destinationParent);
  const resolvedDestination = validatedReplacement ?? path.join(realParent, path.basename(requestedDestination));
  let staging = await fsp.mkdtemp(path.join(realParent, `.${path.basename(requestedDestination)}.extract-`));
  const state = { expandedBytes: 0, members: 0, names: new Set() };
  const extract = tar.extract();
  let decompressedBytes = 0;
  const decompressionLimit = new Transform({
    transform(chunk, _encoding, callback) {
      decompressedBytes += chunk.length;
      if (decompressedBytes > limits.maxDecompressedBytes) {
        callback(new Error("Archive exceeds the decompressed-size limit."));
        return;
      }
      callback(null, chunk);
    },
  });

  extract.on("entry", (header, stream, next) => {
    (async () => {
      const member = safeMember(header, state, limits);
      const target = path.join(staging, ...member.segments);
      if (!target.startsWith(`${staging}${path.sep}`)) throw new Error("Archive member escaped the staging directory.");

      if (member.type === "directory") {
        await fsp.mkdir(target, { recursive: true, mode: 0o755 });
        stream.resume();
        await new Promise((resolve, reject) => {
          stream.once("end", resolve);
          stream.once("error", reject);
        });
        return;
      }

      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await pipeline(stream, fs.createWriteStream(target, { flags: "wx", mode: 0o644 }));
      const actualSize = (await fsp.stat(target)).size;
      if (actualSize !== member.size) throw new Error(`Archive member ${JSON.stringify(member.name)} size did not match its header.`);
    })().then(next, (error) => extract.destroy(error));
  });

  try {
    await pipeline(fs.createReadStream(archive), createGunzip(), decompressionLimit, extract);
    await assertRegularTree(staging);
    if (options.replaceExisting) {
      await replaceTree(staging, resolvedDestination);
      staging = null;
    } else {
      await mergeTree(staging, resolvedDestination);
    }
    return { expandedBytes: state.expandedBytes, members: state.members };
  } finally {
    if (staging) await fsp.rm(staging, { recursive: true, force: true });
  }
}

module.exports = { DEFAULT_LIMITS, extractTarGzSafely };
