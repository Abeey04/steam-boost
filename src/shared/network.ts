// The networks the OS reports (main/network/interfaces.ts), as the app passes them around.

export type NetworkInterfaceKind = 'wifi' | 'usb' | 'ethernet' | 'bridge' | 'other'
export type IpFamily = 4 | 6

export interface NetworkAddress {
  address: string
  family: IpFamily
  netmask?: string
  subnet?: string
}

export interface NetworkInterfaceInfo {
  /** Stable identifier: the OS device name. On Windows that's the adapter's alias ("Wi-Fi",
   * "Ethernet 3"), on macOS en0, on Linux wlp2s0. */
  id: string
  device: string
  /** What the OS shows people: the alias on Windows, the hardware port on macOS ("iPhone USB"). */
  displayName: string
  addresses: NetworkAddress[]
  kind: NetworkInterfaceKind
  mac?: string
}
