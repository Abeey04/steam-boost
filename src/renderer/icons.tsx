import type { NetworkInterfaceKindLabel } from './types'

// Steam Boost's mark and a handful of line icons, drawn here rather than pulled from a library.

type IconProps = { size?: number; className?: string }

function Icon({
  size = 18,
  className,
  children
}: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  )
}

/** The app's mark: three connections braided into one download arrow (build/icon.svg). */
export function Logo({ size = 28 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden>
      <defs>
        <linearGradient id="logo-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1c232d" />
          <stop offset="1" stopColor="#0b0e12" />
        </linearGradient>
        <linearGradient id="logo-arrow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6ff5ae" />
          <stop offset="1" stopColor="#1fbf6a" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="116" fill="url(#logo-bg)" />
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M140 104C140 190 256 176 256 262" stroke="#4cc2ff" strokeWidth="34" />
        <path d="M372 104C372 190 256 176 256 262" stroke="#c58bff" strokeWidth="34" />
        <path d="M256 96V262" stroke="#ffa94d" strokeWidth="34" />
        <path d="M256 250V392M176 312L256 392L336 312" stroke="url(#logo-arrow)" strokeWidth="46" />
      </g>
    </svg>
  )
}

export function WifiIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M2.5 9.2a14 14 0 0 1 19 0" />
      <path d="M5.6 12.6a9.5 9.5 0 0 1 12.8 0" />
      <path d="M8.8 15.9a5 5 0 0 1 6.4 0" />
      <circle cx="12" cy="19.2" r="0.9" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function PhoneIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="7" y="2.5" width="10" height="19" rx="2.2" />
      <path d="M11 18.2h2" />
    </Icon>
  )
}

export function EthernetIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 8.5h16v9.5H4z" />
      <path d="M8.5 8.5V6h7v2.5" />
      <path d="M8 14v4M12 14v4M16 14v4" />
    </Icon>
  )
}

export function GlobeIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
    </Icon>
  )
}

export function KindIcon({
  kind,
  ...props
}: IconProps & { kind: NetworkInterfaceKindLabel }): React.JSX.Element {
  if (kind === 'wifi') return <WifiIcon {...props} />
  if (kind === 'usb') return <PhoneIcon {...props} />
  if (kind === 'ethernet') return <EthernetIcon {...props} />
  return <GlobeIcon {...props} />
}

export function CheckIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Icon>
  )
}

export function AlertIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.8v5" />
      <circle cx="12" cy="16.3" r="0.9" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function SpinnerIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props} className={`spin ${props.className ?? ''}`}>
      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
    </Icon>
  )
}

export function ChevronIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M6 9l6 6 6-6" />
    </Icon>
  )
}

export function ExternalIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
    </Icon>
  )
}

export function CloseIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  )
}
