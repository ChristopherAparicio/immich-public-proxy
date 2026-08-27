import { APP_VERSION } from '../version'

const SOURCE_REPOSITORY = 'https://github.com/ChristopherAparicio/immich-public-proxy'

export function sourceCodeUrl (): string {
  const ref = APP_VERSION === 'dev' ? 'immich-share' : `v${APP_VERSION}`
  return `${SOURCE_REPOSITORY}/tree/${encodeURIComponent(ref)}`
}

/** AGPL-3.0 section 13 source offer shown on every interactive HTML page. */
export function SourceOffer () {
  return (
    <footer class="source-offer" style="padding:1rem;text-align:center;font:12px system-ui,sans-serif;opacity:.75">
      <a href={sourceCodeUrl()} rel="license" style="color:inherit;text-decoration:underline">
        Source code for this service (AGPL-3.0)
      </a>
    </footer>
  )
}
