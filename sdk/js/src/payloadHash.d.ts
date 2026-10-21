export function sha256Hex(bytes: BufferSource): Promise<string>;
export function encodeUtf8Bytes(value: string): Uint8Array;
export function computePayloadHashHeader(
  body: string | Uint8Array | ArrayBuffer,
): Promise<{ bytes: Uint8Array; hashHex: string }>;
