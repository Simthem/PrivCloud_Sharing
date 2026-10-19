// Synthetic TIFF/DNG with a small image and distant, large sensor storage.
// Both browser and unit fixtures use the same offsets; no RAW sensor decoding.
function rawPreviewFixture(payload, options = {}) {
  const size = options.size ?? 100 * 1024 * 1024;
  const imageOffset = options.imageOffset ?? 50 * 1024 * 1024;
  const little = options.little ?? true;
  const jpeg = options.jpeg ?? true;
  const metadata = new Uint8Array(1024);
  const view = new DataView(metadata.buffer);
  metadata.set(little ? [0x49, 0x49] : [0x4d, 0x4d]);
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  function ifd(at, tags) {
    view.setUint16(at, tags.length, little);
    tags.forEach(([id, type, count, value], i) => {
      const offset = at + 2 + i * 12;
      view.setUint16(offset, id, little);
      view.setUint16(offset + 2, type, little);
      view.setUint32(offset + 4, count, little);
      if (type === 3 && count === 1) view.setUint16(offset + 8, value, little);
      else view.setUint32(offset + 8, value, little);
    });
  }
  ifd(8, [
    [256, 4, 1, 6000],
    [257, 4, 1, 4000],
    [262, 3, 1, 32803],
    [274, 3, 1, options.orientation ?? 6],
    [330, 4, 1, 512],
  ]);
  ifd(512, [
    [254, 4, 1, 1],
    [256, 4, 1, 64],
    [257, 4, 1, 48],
    [258, 3, 3, 800],
    [259, 3, 1, jpeg ? 7 : 1],
    [262, 3, 1, jpeg ? 6 : 2],
    [273, 4, 1, imageOffset],
    [277, 3, 1, 3],
    [278, 4, 1, 48],
    [279, 4, 1, payload.length],
  ]);
  [8, 8, 8].forEach((value, i) => view.setUint16(800 + i * 2, value, little));
  const parts = [
    { offset: 0, bytes: metadata },
    { offset: imageOffset, bytes: payload },
  ];
  return {
    size,
    metadata,
    imageOffset,
    read(start, end) {
      const bytes = new Uint8Array(end - start);
      for (const part of parts) {
        const from = Math.max(start, part.offset),
          to = Math.min(end, part.offset + part.bytes.length);
        if (to > from)
          bytes.set(
            part.bytes.subarray(from - part.offset, to - part.offset),
            from - start,
          );
      }
      return bytes;
    },
  };
}
module.exports = { rawPreviewFixture };
