export function parseTlsClientHello(buffer, maximumBytes = 16 * 1024) {
  if (!Buffer.isBuffer(buffer) || buffer.length > maximumBytes) return { error: "PIECE_EGRESS_DENIED" };
  if (buffer.length < 5) return { pending: true };
  if (buffer[0] !== 22) return { error: "PIECE_EGRESS_DENIED" };
  const recordLength = buffer.readUInt16BE(3);
  if (recordLength > maximumBytes - 5) return { error: "PIECE_EGRESS_DENIED" };
  if (buffer.length < recordLength + 5) return { pending: true };
  let offset = 5;
  if (buffer[offset] !== 1) return { error: "PIECE_EGRESS_DENIED" };
  offset += 4 + 2 + 32;
  if (offset >= buffer.length) return { error: "PIECE_EGRESS_DENIED" };
  offset += 1 + buffer[offset];
  if (offset + 2 > buffer.length) return { error: "PIECE_EGRESS_DENIED" };
  offset += 2 + buffer.readUInt16BE(offset);
  if (offset >= buffer.length) return { error: "PIECE_EGRESS_DENIED" };
  offset += 1 + buffer[offset];
  if (offset + 2 > buffer.length) return { error: "PIECE_EGRESS_DENIED" };
  const extensionsEnd = offset + 2 + buffer.readUInt16BE(offset);
  offset += 2;
  if (extensionsEnd > buffer.length) return { error: "PIECE_EGRESS_DENIED" };
  while (offset + 4 <= extensionsEnd) {
    const type = buffer.readUInt16BE(offset);
    const length = buffer.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + length > extensionsEnd) return { error: "PIECE_EGRESS_DENIED" };
    if (type === 0 && length >= 5) {
      const nameType = buffer[offset + 2];
      const nameLength = buffer.readUInt16BE(offset + 3);
      if (nameType !== 0 || nameLength < 1 || nameLength + 5 > length) {
        return { error: "PIECE_EGRESS_DENIED" };
      }
      const hostname = buffer.subarray(offset + 5, offset + 5 + nameLength).toString("ascii").toLowerCase();
      return /^[a-z0-9.-]{1,253}$/.test(hostname)
        ? { hostname }
        : { error: "PIECE_EGRESS_DENIED" };
    }
    offset += length;
  }
  return { error: "PIECE_EGRESS_DENIED" };
}
