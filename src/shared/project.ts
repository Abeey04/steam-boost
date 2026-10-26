// Where Steam Boost lives. Change these if you fork it.

export const PROJECT = {
  name: 'Steam Boost',
  /** owner/name on GitHub: releases, the update check and the website's download links. */
  repo: 'Abeey04/steam-boost',
  github: 'https://github.com/Abeey04/steam-boost',
  /** GitHub Pages for now; steamboost.app once that domain is set up (README, The website). */
  site: 'https://abeey04.github.io/steam-boost'
} as const

/** Links the window may open in the browser; anything else is refused (main/index.ts). */
export const OPENABLE_PREFIXES = [
  `${PROJECT.github}`,
  `${PROJECT.site}`,
  'https://github.com/anmolkapil/plexo'
] as const
