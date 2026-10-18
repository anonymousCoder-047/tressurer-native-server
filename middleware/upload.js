const multer = require('multer');

const ALLOWED_MIME = /^image\/|application\/pdf$/;

// Memory storage: the route hashes the buffer and writes it under
// uploads/{workspace}/{user}/{date}/ itself — multer never touches disk paths.
module.exports = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 20 }, // 5 MB/file, ≤20 files; routes cap 25 MB total
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only images and PDFs are allowed'));
    }
  },
});
