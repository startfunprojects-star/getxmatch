'use strict';

// Scan everything already in uploads/ with the NSFW filter (src/nsfw.js).
//
//   npm run nsfw-scan                 report flagged files only
//   npm run nsfw-scan -- --quarantine also move flagged files to data/quarantine/
//
// A quarantined file is no longer served (its /uploads/ link stops working),
// but nothing is deleted: move it back into uploads/ to restore it.

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const nsfw = require('../src/nsfw');

const IMAGE = /\.(jpe?g|png|webp|gif)$/i;
const VIDEO = /\.(mp4|mov|m4v|webm)$/i;

(async () => {
  const quarantine = process.argv.includes('--quarantine');
  const qDir = path.join(config.dataDir, 'quarantine');

  if (!(await nsfw.ready())) {
    console.error('The NSFW model could not be loaded.');
    process.exit(1);
  }

  const files = fs.readdirSync(config.uploadsDir).filter((f) => IMAGE.test(f) || VIDEO.test(f));
  console.log(`Scanning ${files.length} file(s) in ${config.uploadsDir} …`);

  let flagged = 0;
  for (const [i, name] of files.entries()) {
    const file = path.join(config.uploadsDir, name);
    const { blocked, unreadable } = VIDEO.test(name) ? await nsfw.checkVideo(file) : await nsfw.checkImage(file);
    if (!blocked) continue;
    flagged++;
    let note = unreadable ? 'unreadable' : 'NSFW';
    if (quarantine) {
      fs.mkdirSync(qDir, { recursive: true });
      fs.renameSync(file, path.join(qDir, name));
      note += ' → quarantined';
    }
    console.log(`[${i + 1}/${files.length}] ${name}: ${note}`);
  }

  console.log(`Done. ${flagged} of ${files.length} file(s) flagged${flagged && !quarantine ? ' (run with --quarantine to move them out of uploads/)' : ''}.`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
