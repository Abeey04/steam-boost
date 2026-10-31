import type { NetworkInterfaceInfo } from '../../shared/network'

// What the window calls each network. The OS names them after their adapters ("Ethernet 3" is
// how Windows shows a phone tethered over USB); people know them by what they plugged in.

const IPHONE = /iphone|ipad|apple mobile device/i
/** Android's USB tethering: RNDIS, as Windows describes it, or the newer NCM. */
const ANDROID = /remote ndis|rndis|internet sharing|android/i

/** Adapters for virtual machines, containers and VPNs, from what Windows calls them (WSL and
 * Hyper-V switches, VirtualBox, VMware, TAP, WireGuard, Tailscale, ZeroTier, …). */
const VIRTUAL_DESCRIPTION =
  /hyper-v|virtualbox|vmware|parallels|docker|wsl|tap-windows|\btap\b|wintun|wireguard|tailscale|zerotier|openvpn|nordlynx|mullvad|proton ?vpn|hamachi|radmin|anyconnect|globalprotect|pangp|fortinet|forticlient|npcap|loopback|virtual (ethernet|adapter|miniport|port)|tunnel|\bvpn\b/i
/** The same on macOS and Linux, from the device's name: utun0, wg0, docker0, vboxnet0, … */
const VIRTUAL_DEVICE =
  /^(utun|ipsec|tun|tap|wg|tailscale|zt|docker|br-|veth|virbr|vboxnet|vmnet|lxcbr|lxdbr|cni|flannel|podman|awdl|llw|anpi|vethernet)/i

/** Whether `iface` reaches a virtual machine, a container or a VPN rather than a line of its own.
 * Those start switched off: a VPN with a way to the internet would otherwise carry Steam's
 * downloads too, slowly. */
export function isVirtual(
  iface: Pick<NetworkInterfaceInfo, 'device' | 'displayName' | 'description'>
): boolean {
  return (
    VIRTUAL_DESCRIPTION.test(`${iface.description ?? ''} ${iface.displayName}`) ||
    VIRTUAL_DEVICE.test(iface.device)
  )
}

/** The name to show for `iface` until someone gives it one of their own. */
export function friendlyName(iface: NetworkInterfaceInfo): string {
  // A WSL or Hyper-V switch says it's Ethernet; its own name ("vEthernet (WSL)") says more.
  if (iface.virtual || isVirtual(iface)) return iface.displayName
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
