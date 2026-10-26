export function Switch({
  checked,
  onChange,
  label,
  size = 'md',
  disabled = false
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={`switch switch-${size}${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />
    </button>
  )
}
