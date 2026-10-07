/**
 * GitHub Releases fixtures shared by the built-app update tests.
 * The stable list leads with a draft and a prerelease so callers can prove
 * the checker keeps the first validated stable entry.
 */

export type GithubUpdateFixtureKind =
  | 'stable'
  | 'draft-only'
  | 'prerelease-only'
  | 'malformed'
  | 'empty'
  | 'http-error'
  | 'timeout';

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
