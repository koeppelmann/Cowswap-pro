import { keccak256, stringToHex, type Hex } from 'viem';

/**
 * CoW Protocol appData.
 *
 * The order's on-chain `appData` field is the keccak256 of the EXACT UTF-8 bytes
 * of a JSON "full appData" document. CoW resolves the hash → document for
 * attribution (appCode), order classification, analytics, etc. A zero hash
 * resolves to `{}` (anonymous) — which is what we used before.
 *
 * We use a STATIC document so its hash is constant and can be committed into the
 * deterministic Safe address (the TWAP struct bakes `appData`). The document is
 * uploaded once per network (idempotent) via `PUT /api/v1/app_data/{hash}`; the
 * hash alone is still valid on-chain even if the upload hasn't propagated.
 *
 * IMPORTANT: hash and upload must use the SAME serialized string. We serialize a
 * literal object once here and reuse `APP_DATA_DOC` for both.
 */
const DOC = {
  appCode: 'TWAP Safe',
  metadata: {
    orderClass: { orderClass: 'twap' },
  },
  version: '1.1.0',
} as const;

/** The exact JSON string that is hashed and uploaded (byte-for-byte). */
export const APP_DATA_DOC: string = JSON.stringify(DOC);

/** keccak256 of the UTF-8 bytes of APP_DATA_DOC — the order's `appData` field. */
export const APP_DATA_HASH: Hex = keccak256(stringToHex(APP_DATA_DOC));
