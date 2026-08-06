import https from 'https';
import { GITHUB_REPO } from './app-metadata';

/**
 * Update checking, not update installing.
 *
 * The two artifact families this app actually ships — Windows portable/zip and
 * Linux AppImage/deb/rpm — cannot all be replaced in place from inside a running
 * Electron process (portable exes and distro packages have no updater path at
 * all), so promising "automatic update" for them would be a lie in three cases
 * out of five. What is honest and works everywhere is this: ask GitHub what the
 * newest release is, compare it against our own version, and let the user open
 * the release page. Nothing is downloaded, nothing is executed.
 *
 * A failed check is not an error the user has to deal with — it is almost always
 * a network that isn't there. It therefore never raises a dialog; it only ever
 * fills in a line on the About page.
 */

export type UpdateState = 'idle' | 'checking' | 'available' | 'current' | 'error';

/** Why a check failed, in terms the panel can phrase for a human. */
export type UpdateError = 'offline' | 'rate_limited' | 'no_release' | 'unreadable' | 'http';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  releaseNotes?: string;
  /** ISO 8601, straight from GitHub. */
  publishedAt?: string;
  /** Epoch ms of the last completed check, successful or not. */
  checkedAt?: number;
  error?: UpdateError;
  httpStatus?: number;
}

const API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
/** Release bodies are unbounded; the panel shows an excerpt, not a document. */
const MAX_NOTES_CHARS = 4000;

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  body?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
}

/** Split "v1.2.3-beta.1" into its numeric core and its prerelease identifiers. */
function parseVersion(raw: string): { core: number[]; pre: string[] } {
  const cleaned = raw.trim().replace(/^v/i, '');
  const [core, ...rest] = cleaned.split('-');
  const build = rest.join('-').split('+')[0];
  return {
    core: core.split('.').map((part) => {
      const n = parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    }),
    pre: build ? build.split('.') : [],
  };
}

/**
 * Ordering over the version strings this project actually produces: dotted
 * numbers, occasionally with a prerelease suffix. Not a full semver
 * implementation — build metadata is dropped rather than ignored per spec — but
 * it gets the one comparison that matters right, including "0.0.10 > 0.0.9",
 * which a string compare does not.
 */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  const len = Math.max(va.core.length, vb.core.length);
  for (let i = 0; i < len; i++) {
    const diff = (va.core[i] ?? 0) - (vb.core[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  // Same numbers: a prerelease precedes the release it leads up to.
  if (va.pre.length === 0 && vb.pre.length === 0) return 0;
  if (va.pre.length === 0) return 1;
  if (vb.pre.length === 0) return -1;
  const preLen = Math.max(va.pre.length, vb.pre.length);
  for (let i = 0; i < preLen; i++) {
    const pa = va.pre[i];
    const pb = vb.pre[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    const na = parseInt(pa, 10);
    const nb = parseInt(pb, 10);
    const bothNumeric = /^\d+$/.test(pa) && /^\d+$/.test(pb);
    if (bothNumeric) {
      if (na !== nb) return na > nb ? 1 : -1;
    } else if (pa !== pb) {
      return pa > pb ? 1 : -1;
    }
  }
  return 0;
}

function fetchLatestRelease(userAgent: string): Promise<GitHubRelease> {
  return new Promise((resolve, reject) => {
    const doRequest = (url: string, redirects: number) => {
      if (redirects > MAX_REDIRECTS) {
        return reject(Object.assign(new Error('Too many redirects'), { reason: 'http' as UpdateError }));
      }
      const req = https.get(
        url,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': userAgent,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            // A renamed repo answers this endpoint with a 301.
            return doRequest(new URL(res.headers.location, url).toString(), redirects + 1);
          }
          if (status !== 200) {
            res.resume();
            // 404 here is not a broken app: it is a repo whose only releases are
            // drafts or prereleases, which this endpoint declines to return.
            const reason: UpdateError =
              status === 404 ? 'no_release'
                : status === 403 || status === 429 ? 'rate_limited'
                  : 'http';
            return reject(Object.assign(new Error(`HTTP ${status}`), { reason, status }));
          }
          let body = '';
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => { body += chunk; });
          res.on('end', () => {
            try {
              resolve(JSON.parse(body) as GitHubRelease);
            } catch {
              reject(Object.assign(new Error('Malformed response'), { reason: 'unreadable' as UpdateError }));
            }
          });
          res.on('error', (err) => {
            reject(Object.assign(err, { reason: 'offline' as UpdateError }));
          });
        },
      );

      req.on('error', (err) => {
        reject(Object.assign(err, { reason: 'offline' as UpdateError }));
      });

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy();
        reject(Object.assign(new Error('Update check timed out'), { reason: 'offline' as UpdateError }));
      });
    };

    doRequest(API_URL, 0);
  });
}

export class UpdateChecker {
  private current: UpdateStatus;
  private inFlight: Promise<UpdateStatus> | null = null;

  /**
   * @param version  this build's version, as `app.getVersion()` reports it.
   * @param onChange called on every state transition, so a panel that is already
   *                 open sees "checking" and its result without polling.
   */
  constructor(private readonly version: string, private readonly onChange: (status: UpdateStatus) => void) {
    this.current = { state: 'idle', currentVersion: version };
  }

  /** Last known result. The startup check can finish before any window exists. */
  status(): UpdateStatus {
    return this.current;
  }

  /**
   * A check already running is returned as-is rather than started twice: the
   * startup check and an impatient click on the button overlap easily, and the
   * second request would only spend the caller's rate limit.
   */
  check(): Promise<UpdateStatus> {
    if (this.inFlight) return this.inFlight;

    // Keep whatever was already found while re-checking, so the line the user is
    // reading does not blank out and come back.
    this.publish({ ...this.current, state: 'checking', error: undefined, httpStatus: undefined });

    this.inFlight = fetchLatestRelease(`SubFlow/${this.version}`)
      .then((release) => {
        const tag = (release.tag_name || release.name || '').trim();
        if (!tag) {
          return this.publish({
            state: 'error',
            currentVersion: this.version,
            checkedAt: Date.now(),
            error: 'unreadable',
          });
        }
        const latestVersion = tag.replace(/^v/i, '');
        const ahead = compareVersions(latestVersion, this.version) > 0;
        const notes = (release.body || '').replace(/\r\n/g, '\n').trim();
        return this.publish({
          state: ahead ? 'available' : 'current',
          currentVersion: this.version,
          latestVersion,
          releaseUrl: release.html_url,
          releaseNotes: notes ? notes.slice(0, MAX_NOTES_CHARS) : undefined,
          publishedAt: release.published_at,
          checkedAt: Date.now(),
        });
      })
      .catch((err: Error & { reason?: UpdateError; status?: number }) => {
        console.error('Update check failed:', err?.message || err);
        return this.publish({
          ...this.current,
          state: 'error',
          currentVersion: this.version,
          checkedAt: Date.now(),
          error: err?.reason || 'offline',
          httpStatus: err?.status,
        });
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private publish(status: UpdateStatus): UpdateStatus {
    this.current = status;
    this.onChange(status);
    return status;
  }
}
