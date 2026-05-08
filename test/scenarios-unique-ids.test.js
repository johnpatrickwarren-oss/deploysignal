'use strict';
/**
 * test/scenarios-unique-ids.test.js
 *
 * Asserts all scenario IDs in runs/adversarial-scenarios.json are unique.
 * Run: node test/scenarios-unique-ids.test.js
 */
const fs   = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'runs', 'adversarial-scenarios.json');
if (!fs.existsSync(filePath)) {
  console.error('Scenario file not found: ' + filePath);
  process.exit(1);
}

const scenarios = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const seen = {};
const dupes = [];

for (let i = 0; i < scenarios.length; i++) {
  const id = scenarios[i].id;
  if (seen[id] !== undefined) {
    dupes.push({ id, first: seen[id], duplicate: i });
  } else {
    seen[id] = i;
  }
}

console.log('Scenario unique-ID check: ' + scenarios.length + ' scenarios, ' + Object.keys(seen).length + ' unique IDs');

if (dupes.length > 0) {
  console.log('\nFAIL — ' + dupes.length + ' duplicate ID(s):');
  for (const d of dupes) {
    console.log('  "' + d.id + '" at index ' + d.duplicate + ' (first seen at ' + d.first + ')');
  }
  process.exit(1);
} else {
  console.log('PASS — all IDs unique.');
  process.exit(0);
}
