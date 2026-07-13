import fetch from 'node-fetch';

// Roblox's modern thumbnail API is a two-step resolve: you don't get a direct
// image URL from an asset ID, you get one by querying thumbnails.roblox.com,
// which returns a CDN URL that's valid for a while (not permanent, but stable
// enough to cache for a session). See:
// https://devforum.roblox.com/t/convert-rbxassetid-to-image-url/2415649
// https://thumbnails.roblox.com/docs/index.html

const THUMBNAIL_API = 'https://thumbnails.roblox.com/v1/assets';
const THUMBNAIL_CACHE_TTL = 6 * 60 * 60 * 1000; // 6hr — plenty, these rarely change mid-session

const thumbnailCache = new Map(); // assetId -> { url, time }

function extractAssetId(rbxAssetIdString) {
  if (!rbxAssetIdString) return null;
  const match = /rbxassetid:\/\/(\d+)/.exec(rbxAssetIdString);
  return match ? match[1] : null;
}

// Resolves a single "rbxassetid://12345" string to a real https image URL.
// Returns null if the input is empty/malformed or the API call fails —
// callers should treat a null return as "no thumbnail available" and omit
// the image rather than erroring out the whole embed.
export async function resolveThumbnail(rbxAssetIdString, size = '420x420') {
  const assetId = extractAssetId(rbxAssetIdString);
  if (!assetId) return null;

  const cacheKey = `${assetId}:${size}`;
  const cached = thumbnailCache.get(cacheKey);
  if (cached && Date.now() - cached.time < THUMBNAIL_CACHE_TTL) {
    return cached.url;
  }

  try {
    const url = `${THUMBNAIL_API}?assetIds=${assetId}&size=${size}&format=Png`;
    const res = await fetch(url, { headers: { 'User-Agent': 'ps99-discord-bot/1.0' } });
    if (!res.ok) return null;

    const json = await res.json();
    const entry = json?.data?.[0];
    if (!entry || entry.state !== 'Completed' || !entry.imageUrl) return null;

    thumbnailCache.set(cacheKey, { url: entry.imageUrl, time: Date.now() });
    return entry.imageUrl;
  } catch (err) {
    console.error('[thumbnails] Failed to resolve', rbxAssetIdString, ':', err.message);
    return null;
  }
}

// Resolves several asset IDs in one batched API call (the endpoint supports
// comma-separated assetIds). Returns a Map of original rbxassetid string -> URL
// (or no entry if unresolved). Prefer this over resolveThumbnail in a loop.
export async function resolveThumbnails(rbxAssetIdStrings, size = '420x420') {
  const results = new Map();
  const toFetch = []; // [{ raw, assetId }]

  for (const raw of rbxAssetIdStrings) {
    const assetId = extractAssetId(raw);
    if (!assetId) continue;

    const cacheKey = `${assetId}:${size}`;
    const cached = thumbnailCache.get(cacheKey);
    if (cached && Date.now() - cached.time < THUMBNAIL_CACHE_TTL) {
      results.set(raw, cached.url);
    } else {
      toFetch.push({ raw, assetId });
    }
  }

  if (toFetch.length === 0) return results;

  // Roblox's batch endpoint accepts a comma-separated list; keep batches
  // modest (50) to stay well under any practical URL-length limit.
  const BATCH_SIZE = 50;
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    const idsParam = batch.map((b) => b.assetId).join(',');

    try {
      const url = `${THUMBNAIL_API}?assetIds=${idsParam}&size=${size}&format=Png`;
      const res = await fetch(url, { headers: { 'User-Agent': 'ps99-discord-bot/1.0' } });
      if (!res.ok) continue;

      const json = await res.json();
      const byAssetId = new Map((json?.data ?? []).map((e) => [String(e.targetId), e]));

      for (const { raw, assetId } of batch) {
        const entry = byAssetId.get(assetId);
        if (entry?.state === 'Completed' && entry.imageUrl) {
          const cacheKey = `${assetId}:${size}`;
          thumbnailCache.set(cacheKey, { url: entry.imageUrl, time: Date.now() });
          results.set(raw, entry.imageUrl);
        }
      }
    } catch (err) {
      console.error('[thumbnails] Batch resolve failed:', err.message);
    }
  }

  return results;
}
