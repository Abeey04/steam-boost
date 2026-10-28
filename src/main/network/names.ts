import type { NetworkInterfaceInfo } from '../../shared/network'

// What the window calls each network. The OS names them after their adapters ("Ethernet 3" is
// how Windows shows a phone tethered over USB); people know them by what they plugged in.

const IPHONE = /iphone|ipad|apple mobile device/i
/** Android's USB tethering: RNDIS, as Windows describes it, or the newer NCM. */
const ANDROID = /remote ndis|rndis|internet sharing|android/i

/** The name to show for `iface` until someone gives it one of their own. */
export function friendlyName(iface: NetworkInterfaceInfo): string {
  const text = `${iface.description ?? ''} ${iface.displayName}`
  if (IPHONE.test(text)) return 'iPhone (USB)'
  if (ANDROID.test(text)) return 'Phone (USB tethering)'
  if (iface.kind === 'usb') {
    // Linux names a device without saying what it is: there, a tethered phone and a USB
    // Ethernet adapter look alike.
    return iface.description === undefined ? 'Phone or USB adapter' : 'USB network adapter'
  }
  if (iface.kind === 'wifi') return 'Wi-Fi'
  if (iface.kind === 'ethernet') return 'Ethernet'
  return iface.displayName
}

/** Each network's name, by id. Two that would share one keep the OS's names instead, which tell
 * them apart ("Wi-Fi" and "Wi-Fi 2"). */
export function friendlyNames(ifaces: readonly NetworkInterfaceInfo[]): Map<string, string> {
  const names = new Map(ifaces.map((iface) => [iface.id, friendlyName(iface)]))
  const counts = new Map<string, number>()
  for (const name of names.values()) counts.set(name, (counts.get(name) ?? 0) + 1)
  for (const iface of ifaces) {
    if ((counts.get(friendlyName(iface)) ?? 0) > 1) names.set(iface.id, iface.displayName)
  }
  return names
}
