'use strict';

// Auto-share: every picture a member uploads (profile picture, gallery, picture
// buffer, Recent Activity image) is also posted to the Highway, where the
// Highway audience rule (see highway.audienceFilter) decides who sees it. The
// file is copied so pruning the Highway post never deletes the original, and
// deleting the original never breaks the post.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const hw = require('./highway');
const { broadcastHighway } = require('./socket');

function removeUpload(filename) {
  if (!filename) return;
  fs.promises.unlink(path.join(config.uploadsDir, path.basename(filename))).catch(() => {});
}

// Post a copy of `filename` (already in the uploads dir) to the Highway as
// `userId`, with a short caption. Failures are swallowed — the upload itself
// has already succeeded and must not be affected.
function shareUploadToHighway(userId, filename, body) {
  try {
    const src = path.join(config.uploadsDir, path.basename(filename));
    const copy = crypto.randomBytes(16).toString('hex') + path.extname(filename);
    fs.copyFileSync(src, path.join(config.uploadsDir, copy));

    const { id, prunedImages } = hw.createPost({ userId, body: body || '', image: copy, origin: null });
    prunedImages.forEach(removeUpload);

    const r = hw.byId(id);
    broadcastHighway({
      id: r.id,
      body: r.body || '',
      image: `/uploads/${r.image}`,
      createdAt: r.created_at,
      author: {
        id: r.user_id,
        username: r.username,
        displayName: r.display_name || r.username,
        avatar: r.avatar ? `/uploads/${r.avatar}` : null,
      },
    }, (viewerId) => hw.canSeeAuthor(viewerId, userId));
  } catch (_e) { /* never block the upload */ }
}

module.exports = { shareUploadToHighway };
