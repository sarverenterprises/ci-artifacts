const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const test = require("node:test");
const { createGzip } = require("node:zlib");

const tar = require("tar-stream");

const { DEFAULT_LIMITS, extractTarGzSafely } = require("../src/archive");

async function archiveWith(entries) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "ci-archive-test-"));
  const archive = path.join(directory, "artifact.tar.gz");
  const pack = tar.pack();
  const writing = pipeline(pack, createGzip(), fs.createWriteStream(archive));

  for (const entry of entries) {
    await new Promise((resolve, reject) => {
      const body = entry.body === undefined ? undefined : Buffer.from(entry.body);
      const stream = pack.entry(
        {
          name: entry.name,
          type: entry.type || "file",
          linkname: entry.linkname,
          size: body?.length,
        },
        body,
        (error) => error ? reject(error) : resolve(),
      );
      stream.on("error", reject);
    });
  }
  pack.finalize();
  await writing;
  return { archive, directory };
}

test("safe extraction atomically replaces a stale destination", async () => {
  const { archive, directory } = await archiveWith([
    { name: "index.html", body: "<h1>Journal</h1>" },
    { name: "_astro/", type: "directory" },
    { name: "_astro/app.js", body: "console.log('ok')" },
  ]);
  const destination = path.join(directory, "dist");
  await fsp.mkdir(destination);
  await fsp.writeFile(path.join(destination, "stale.txt"), "stale");

  const result = await extractTarGzSafely(archive, destination, {
    allowedRoot: directory,
    replaceExisting: true,
  });

  assert.deepEqual(result, { expandedBytes: 33, members: 3 });
  assert.equal(await fsp.readFile(path.join(destination, "index.html"), "utf8"), "<h1>Journal</h1>");
  assert.equal(await fsp.readFile(path.join(destination, "_astro/app.js"), "utf8"), "console.log('ok')");
  await assert.rejects(fsp.access(path.join(destination, "stale.txt")));
});

test("safe extraction rejects traversal and link members before destination writes", async () => {
  for (const entry of [
    { name: "../escape.txt", body: "escape" },
    { name: "/absolute.txt", body: "absolute" },
    { name: "link", type: "symlink", linkname: "../outside" },
    { name: "hard", type: "link", linkname: "index.html" },
    { name: "pipe", type: "fifo" },
  ]) {
    const { archive, directory } = await archiveWith([entry]);
    const destination = path.join(directory, "dist");
    await assert.rejects(extractTarGzSafely(archive, destination, {
      allowedRoot: directory,
      replaceExisting: true,
    }), /Unsafe archive|prohibited type/);
    assert.equal(await fsp.readdir(directory).then((items) => items.includes("dist")), false);
    assert.equal(await fsp.readdir(path.dirname(directory)).then((items) => items.includes("escape.txt")), false);
  }
});

test("safe extraction enforces compressed, expanded, member, and per-file limits", async () => {
  const { archive, directory } = await archiveWith([
    { name: "one.txt", body: "12345" },
    { name: "two.txt", body: "67890" },
  ]);

  await assert.rejects(
    extractTarGzSafely(archive, path.join(directory, "compressed"), {
      limits: { ...DEFAULT_LIMITS, maxCompressedBytes: 1 },
    }),
    /compressed-size limit/,
  );
  await assert.rejects(
    extractTarGzSafely(archive, path.join(directory, "expanded"), {
      limits: { ...DEFAULT_LIMITS, maxExpandedBytes: 9 },
    }),
    /expanded-size limit/,
  );
  await assert.rejects(
    extractTarGzSafely(archive, path.join(directory, "decompressed"), {
      limits: { ...DEFAULT_LIMITS, maxDecompressedBytes: 1 },
    }),
    /decompressed-size limit/,
  );
  await assert.rejects(
    extractTarGzSafely(archive, path.join(directory, "members"), {
      limits: { ...DEFAULT_LIMITS, maxMembers: 1 },
    }),
    /member-count limit/,
  );
  await assert.rejects(
    extractTarGzSafely(archive, path.join(directory, "file"), {
      limits: { ...DEFAULT_LIMITS, maxFileBytes: 4 },
    }),
    /per-file size limit/,
  );
});

test("safe replacement refuses broad destinations", async () => {
  const { archive, directory } = await archiveWith([{ name: "index.html", body: "ok" }]);
  await assert.rejects(
    extractTarGzSafely(archive, directory, { allowedRoot: directory, replaceExisting: true }),
    /must be below/,
  );
  await assert.rejects(
    extractTarGzSafely(archive, `${directory}/child/..`, { allowedRoot: directory, replaceExisting: true }),
    /containing '\.\.'/,
  );
  await assert.rejects(
    extractTarGzSafely(archive, path.dirname(directory), { allowedRoot: directory, replaceExisting: true }),
    /must be below/,
  );
});

test("safe replacement rejects a symlinked parent that escapes its allowed root", async () => {
  const { archive, directory } = await archiveWith([{ name: "index.html", body: "ok" }]);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "ci-archive-outside-"));
  await fsp.symlink(outside, path.join(directory, "escape"));

  await assert.rejects(
    extractTarGzSafely(archive, path.join(directory, "escape", "dist"), {
      allowedRoot: directory,
      replaceExisting: true,
    }),
    /real destination-parent directory/,
  );

  const missingChild = path.join(outside, "new");
  await assert.rejects(
    extractTarGzSafely(archive, path.join(directory, "escape", "new", "dist"), {
      allowedRoot: directory,
      replaceExisting: true,
    }),
    /existing destination parent/,
  );
  await assert.rejects(fsp.access(missingChild));
});
