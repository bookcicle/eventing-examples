/**
 * Computes SHA-256 hex digest over exact UTF-8 or binary request body bytes
 * for CloudFront Lambda Origin Access Control (`x-amz-content-sha256`).
 */
export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto API (crypto.subtle) is required for SHA-256 payload hashing");
  }
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function encodeUtf8Bytes(str) {
  return new TextEncoder().encode(String(str));
}

export async function computePayloadHashHeader(serializedBody) {
  const bytes =
    typeof serializedBody === "string"
      ? encodeUtf8Bytes(serializedBody)
      : serializedBody instanceof Uint8Array
        ? serializedBody
        : new Uint8Array(serializedBody);
  const hashHex = await sha256Hex(bytes);
  return {
    bytes,
    hashHex,
  };
}
