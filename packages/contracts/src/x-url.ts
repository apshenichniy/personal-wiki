export function normalizeSubmission(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError("Supply a supported X post URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    ![
      "x.com",
      "www.x.com",
      "twitter.com",
      "www.twitter.com",
      "fxtwitter.com",
      "www.fxtwitter.com",
    ].includes(url.hostname.toLowerCase())
  )
    throw new TypeError("Supply a supported X post URL.");
  const match = /^\/(?:[A-Za-z0-9_]{1,20}|i)\/status\/([1-9][0-9]{0,24})\/?$/.exec(url.pathname);
  if (!match?.[1]) throw new TypeError("Supply a supported X post URL.");
  const anchorId = match[1];
  return {
    anchorId,
    sourceKey: `x:post:${anchorId}`,
    normalizedUrl: `https://x.com/i/status/${anchorId}`,
  };
}
