import { expect, test, type Page } from '@playwright/test'

// Every state of the window, light and dark, against its screenshot in test/ui/screenshots: a
// change to styles.css or a component that moves anything shows up here. The clock is fixed and
// the made-up speeds follow it (mock.js), so each run draws the same window. After a change meant
// to show, `npm run test:ui -- --update-snapshots` takes new screenshots, to look over in the diff
// before they're committed.

const SCENARIOS = [
  'boosting',
  'ready',
  'setup',
  'restart',
  'lan',
  'error',
  'starting',
  'off',
  'single',
  'update'
]

/** Opens the window in `scenario`, a minute of made-up downloading in, and checks it neither
 * errs nor gets wider than its window. */
async function open(page: Page, scenario: string, scheme: 'light' | 'dark'): Promise<string[]> {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
  // Stopped, not just set: time moves only when runFor moves it, the same on every PC.
  await page.clock.install({ time: new Date('2026-10-29T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-10-29T12:00:01Z'))
  await page.goto(`/window?scenario=${scenario}`)
  await page.clock.runFor(60_000)
  await page.evaluate('document.fonts.ready')
  expect(await page.evaluate('document.documentElement.scrollWidth')).toBeLessThanOrEqual(480)
  return errors
}

for (const scheme of ['light', 'dark'] as const) {
  for (const scenario of SCENARIOS) {
    test(`${scenario}, ${scheme}`, async ({ page }) => {
      const errors = await open(page, scenario, scheme)
      await expect(page).toHaveScreenshot(`${scenario}-${scheme}.png`, { fullPage: true })
      expect(errors).toEqual([])
    })
  }
}

test('the other adapters open from their fold, and a daily cap is set in its row', async ({
  page
}) => {
  const errors = await open(page, 'boosting', 'light')
  await page.getByText('Other adapters').click()
  await page.getByRole('button', { name: 'Change cap' }).click()
  await expect(page.getByLabel('Daily cap')).toHaveValue('2')
  await expect(page).toHaveScreenshot('connections-open-light.png', { fullPage: true })
  expect(errors).toEqual([])
})
