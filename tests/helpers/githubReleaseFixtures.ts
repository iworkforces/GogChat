/**
 * GitHub Releases fixtures shared by the built-app update tests.
 * The stable list leads with a draft and a prerelease so callers can prove
 * the checker keeps the first validated stable entry.
 */

export type GithubUpdateFixtureKind =
  'stable' | 'draft-only' | 'prerelease-only' | 'malformed' | 'empty' | 'http-error' | 'timeout';

export interface GithubUpdateFixture {
  ok: boolean;
  status: number;
  body: unknown;
}

export const GITHUB_UPDATE_STABLE_URL =
  'https://github.com/iworkforces/GogChat/releases/tag/v99.0.0';

function stableReleaseList(stableUrl: string): unknown[] {
  return [
    {
      tag_name: 'v98.0.0-draft',
      html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v98.0.0-draft',
      draft: true,
      prerelease: false,
    },
    {
      tag_name: 'v98.0.0-rc.1',
      html_url: 'https://github.com/iworkforces/GogChat/releases/tag/v98.0.0-rc.1',
      draft: false,
      prerelease: true,
    },
    {
      tag_name: 'v99.0.0',
      html_url: stableUrl,
      body: 'Local fixture notes',
      draft: false,
      prerelease: false,
    },
  ];
}

/** Failure fixtures must still contain the newer stable row the success path offers. */
export function temptingStableRelease(
  kind: 'http-error' | 'timeout',
  stableUrl = GITHUB_UPDATE_STABLE_URL
): { tag_name: string; html_url: string } {
  const fixture = githubUpdateFixture(kind, stableUrl);
  if (kind === 'http-error') {
    if (fixture.ok !== false || fixture.status !== 503) {
      throw new Error('http-error fixture must stay an HTTP failure');
    }
  } else if (fixture.ok !== true || fixture.status !== 200) {
    throw new Error('timeout fixture must stay HTTP 200');
  }
  if (!Array.isArray(fixture.body)) {
    throw new Error(`${kind} fixture body must stay a release list`);
  }
  const stable = fixture.body.find((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return false;
    }
    const row = entry as {
      tag_name?: unknown;
      html_url?: unknown;
      draft?: unknown;
      prerelease?: unknown;
    };
    return (
      row.tag_name === 'v99.0.0' &&
      row.html_url === stableUrl &&
      row.draft === false &&
      row.prerelease === false
    );
  }) as { tag_name: string; html_url: string } | undefined;
  if (!stable) {
    throw new Error(`${kind} fixture lost its newer stable release`);
  }
  return stable;
}

export function githubUpdateFixture(
  kind: GithubUpdateFixtureKind,
  stableUrl = GITHUB_UPDATE_STABLE_URL
): GithubUpdateFixture {
  if (kind === 'malformed') {
    return { ok: true, status: 200, body: { not: 'an-array' } };
  }
  if (kind === 'empty') {
    return { ok: true, status: 200, body: [] };
  }
  if (kind === 'http-error') {
    return { ok: false, status: 503, body: stableReleaseList(stableUrl) };
  }
  if (kind === 'draft-only') {
    return {
      ok: true,
      status: 200,
      body: [
        {
          tag_name: 'v99.0.0',
          html_url: stableUrl,
          draft: true,
          prerelease: false,
        },
      ],
    };
  }
  if (kind === 'prerelease-only') {
    return {
      ok: true,
      status: 200,
      body: [
        {
          tag_name: 'v99.0.0',
          html_url: stableUrl,
          draft: false,
          prerelease: true,
        },
      ],
    };
  }
  if (kind === 'timeout') {
    return { ok: true, status: 200, body: stableReleaseList(stableUrl) };
  }
  return { ok: true, status: 200, body: stableReleaseList(stableUrl) };
}
