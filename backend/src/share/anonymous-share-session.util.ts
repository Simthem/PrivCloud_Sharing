export const anonymousShareSessionCookieName = (shareId: string): string =>
  `anonymous_share_${shareId}_session`;

export const anonymousShareSessionCookiePath = (shareId: string): string =>
  `/api/shares/${shareId}`;
