import { useEffect, useRef, type ReactNode } from 'react'

type DialogProps = {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  /** Extra class on the <dialog>, e.g. a wider or scrolling variant. */
  className?: string
}

/** Thin wrapper around the native <dialog>, which handles focus trapping and Escape. */
export function Dialog({ open, title, onClose, children, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className={className ? `dialog ${className}` : 'dialog'}
      aria-labelledby="dialog-title"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      {open && (
        <div className="dialog-body">
          <div className="dialog-header">
            <h2 id="dialog-title" className="dialog-title">{title}</h2>
            <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  )
}
