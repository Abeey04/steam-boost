// Where Steam Boost lives. Change these if you fork it.

export const PROJECT = {
  name: 'Steam Boost',
  /** owner/name on GitHub: releases, the update check and the website's download links. */
  repo: 'Abeey04/steam-boost',
  github: 'https://github.com/Abeey04/steam-boost',
  site: 'https://steamboost.app'
} as const

/** Links the window may open in the browser; anything else is refused (main/index.ts). */
export const OPENABLE_PREFIXES = [
  `${PROJECT.github}`,
  `${PROJECT.site}`,
  'https://github.com/anmolkapil/plexo'
] as const
