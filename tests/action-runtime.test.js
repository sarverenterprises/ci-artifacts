const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

function checkUsingNode24(yamlContent, fileName) {
  // Match runs: using: node24 with optional leading indentation
  const regex = /^\s*runs:\s*\n(?:.*\n)*?^\s*using:\s*node24\s*$/m;
  const match = yamlContent.match(regex);
  assert(match, `${fileName} must declare runs.using as node24`);
}

test('action.yml manifests declare runs.using as node24', () => {
  const files = [
    'upload/action.yml',
    'download/action.yml',
    'presign-upload/action.yml',
  ];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    checkUsingNode24(content, file);
  }
});
