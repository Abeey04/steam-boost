import { join } from 'node:path'
import { Menu, nativeImage, Tray, type NativeImage } from 'electron'
import type { AppState } from '../shared/boost'
import { PROJECT } from '../shared/project'

// The tray icon: Steam Boost keeps running there when its window is closed. Its colour says how
// things stand, and its menu turns the boost on and off.

export type Tone = 'off' | 'attention' | 'ready' | 'error'

/** How things stand, in a colour and a few words. */
export function toneOf(state: AppState): { tone: Tone; label: string } {
  const { boost } = state
  if (!state.settings.enabled || boost.state === 'off') return { tone: 'off', label: 'Off' }
  if (boost.state === 'error') return { tone: 'error', label: "Couldn't start" }
  if (boost.state === 'starting') return { tone: 'attention', label: 'Starting…' }
  if (boost.hostsEntry !== 'set') return { tone: 'attention', label: 'Set up needed' }
  if (boost.lastRequestAt === null && boost.steamUsing !== true) {
    return { tone: 'attention', label: 'Restart Steam to use it' }
  }
  const active = state.networks.filter((network) => network.role === 'active').length
  return {
    tone: 'ready',
    label: `On, over ${active} ${active === 1 ? 'connection' : 'connections'}`
  }
}

export interface TrayActions {
  show: () => void
  setEnabled: (enabled: boolean) => void
  quit: () => void
}

export class AppTray {
  private readonly tray: Tray
  private readonly icons = new Map<Tone, NativeImage>()
  private shown = ''

  constructor(
    private readonly assets: string,
    private readonly actions: TrayActions
  ) {
    this.tray = new Tray(this.icon('off'))
    this.tray.setToolTip(PROJECT.name)
    // Windows and Linux open the window on a click; macOS shows the menu, as its tray icons do.
    if (process.platform !== 'darwin') this.tray.on('click', () => this.actions.show())
  }

  update(state: AppState): void {
    const { tone, label } = toneOf(state)
    const key = `${tone}|${label}|${state.settings.enabled}`
    if (key === this.shown) return
    this.shown = key
    this.tray.setImage(this.icon(tone))
    this.tray.setToolTip(`${PROJECT.name}: ${label}`)
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `${PROJECT.name}: ${label}`, enabled: false },
        { type: 'separator' },
        {
          label: 'Boost Steam downloads',
          type: 'checkbox',
          checked: state.settings.enabled,
          click: (item) => this.actions.setEnabled(item.checked)
        },
        { label: `Open ${PROJECT.name}`, click: () => this.actions.show() },
        { type: 'separator' },
        { label: 'Quit', click: () => this.actions.quit() }
      ])
    )
  }

  destroy(): void {
    this.tray.destroy()
  }

  private icon(tone: Tone): NativeImage {
    let image = this.icons.get(tone)
    if (!image) {
      // macOS draws its menu-bar icons from a black-and-clear template in the bar's own colour;
      // there the state is in the tooltip and menu. Elsewhere the icon is coloured by state. The
      // @2x files next to these are picked up on high-DPI screens.
      image =
        process.platform === 'darwin'
          ? nativeImage.createFromPath(join(this.assets, 'trayTemplate.png'))
          : nativeImage.createFromPath(join(this.assets, `tray-${tone}.png`))
      if (process.platform === 'darwin') image.setTemplateImage(true)
      this.icons.set(tone, image)
    }
    return image
  }
}
