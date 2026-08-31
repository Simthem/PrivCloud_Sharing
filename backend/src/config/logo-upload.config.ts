// The admin logo endpoint accepts one file and no multipart text fields.
// Multer 2.3 requires explicit structural limits to reject malicious field
// nesting and oversized array indexes before they reach append-field.
export const LOGO_UPLOAD_OPTIONS = {
  limits: {
    fieldNameSize: 64,
    fields: 0,
    fileSize: 2 * 1024 * 1024,
    files: 1,
    // Multer triggers this limit when it reaches the value, so one allowed
    // file needs a parts limit of two.
    parts: 2,
    fieldNestingDepth: 0,
    fieldArrayIndexLimit: 0,
  },
} as const;
