const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

/**
 * Extract the direct `runs.using` value from an action.yml content.
 * @param {string} content - The YAML content of an action.yml file.
 * @returns {string|null} - The value of runs.using if found directly, null otherwise.
 */
function directRunsUsing(content) {
  const lines = content.split('\n');

  let runsLineIndex = -1;
  let runsIndent = -1;

  // Find the runs: line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Change condition to only match root-level runs:
    if (trimmed === 'runs:' && line.search(/\S/) === 0) {
      runsLineIndex = i;
      runsIndent = line.search(/\S/);
      break;
    }
  }

  if (runsLineIndex === -1) {
    return null;
  }

  // Collect lines that are direct children of runs (indent > runsIndent)
  const childLines = [];

  for (let i = runsLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (trimmed === '') {
      continue;
    }

    const currentIndent = line.search(/\S/);

    // Stop if we hit same or lower indent (not a child of runs)
    if (currentIndent <= runsIndent) {
      break;
    }

    childLines.push({ line, trimmed, indent: currentIndent });
  }

  if (childLines.length === 0) {
    return null;
  }

  // Find minimum indent among children
  const minIndent = Math.min(...childLines.map(c => c.indent));

  // Find using: at the minimum indent level
  for (const child of childLines) {
    if (child.indent === minIndent && child.trimmed.startsWith('using:')) {
      return child.trimmed.split(':').slice(1).join(':').trim();
    }
  }

  return null;
}

test('real action files have direct runs.using node24', () => {
  const files = [
    'upload/action.yml',
    'download/action.yml',
    'presign-upload/action.yml'
  ];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    assert.equal(directRunsUsing(content), 'node24', `${file} should have direct runs.using node24`);
  }
});

test('top-level using node24 does not mask direct runs.using node20', () => {
  const content = `runs:
  using: node20
  main: dist/index.js

using: node24
`;
  assert.equal(directRunsUsing(content), 'node20');
});

test('nested deeper using node24 is not a direct runs child', () => {
  const content = `runs:
  nested:
    using: node24
`;
  assert.equal(directRunsUsing(content), null);
});

// Regression test: nested inputs.runs before root runs
// Should still find root runs.using node24

test('nested inputs.runs before root runs', () => {
  const content = `inputs:
  runs:
    using: node20
runs:
  using: node24
`;
  assert.equal(directRunsUsing(content), 'node24');
});
