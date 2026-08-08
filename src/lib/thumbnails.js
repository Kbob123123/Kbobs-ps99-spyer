import fetch from 'node-fetch';

// Roblox asset IDs from the PS99 collection come as "rbxassetid://12345".
// Turning one into a displayable image URL needs Roblox's thumbnail service,
// because the raw asset id is not itself an image URL.

const ENDPOINT = 'https://thumbnails.roblox.com/v1/assets';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // asset art effectively never changes

const cache = new Map(); // assetId -> { url, expiresAt }

/**
 * Resolve an rbxassetid:// string to an image URL, or null.
 *
 * Never throws: a thumbnail is decoration, so a failure here degrades the embed
 * to text rather than failing the whole command.
 */
export async function resolveThumbnail(rbxAssetId) {
  if (!rbxAssetId) return null;

  const assetId = String(rbxAssetId).replace('rbxassetid://', '').trim();
  if (!/^\d+$/.test(assetId)) return null;

  const hit = cache.get(assetId);
  if (hit && hit.expiresAt > Date.now()) return hit.url;

  try {
    const res = await fetch(`${ENDPOINT}?assetIds=${assetId}&size=150x150&format=Png&isCircular=false`);
    if (!res.ok) return null;

    const body = await res.json();
    const row = body?.data?.[0];
    // State is "Completed" only once Roblox has actually rendered the asset;
    // anything else (Pending, Blocked) has no usable image yet.
    if (!row || row.state !== 'Completed' || !row.imageUrl) return null;

    cache.set(assetId, { url: row.imageUrl, expiresAt: Date.now() + CACHE_TTL_MS });
    return row.imageUrl;
  } catch (err) {
    console.warn('[thumbnails] Lookup failed:', err.message);
    return null;
  }
}
