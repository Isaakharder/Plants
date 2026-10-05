import { useNavigate } from 'react-router-dom'
import { Dialog } from '../../components/Dialog'
import { formatDate } from '../../lib/dates'
import { useDeleteCrop, useForgetCrop } from './api'
import type { Crop } from './model'

export function DeleteCropDialog({ crop, open, onClose }: { crop: Crop; open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const remove = useDeleteCrop(crop.id)
  const forgetCrop = useForgetCrop()

  function close() {
    if (remove.isPending) return
    remove.reset()
    onClose()
  }

  return (
    <Dialog open={open} title="Delete variety?" onClose={close}>
      <div className="form">
        <p className="confirm-text">
          <strong>{crop.name}</strong> ({formatDate(crop.planting_date)} → {formatDate(crop.pullout_date)}) will be permanently deleted. This can't be undone.
        </p>
        {remove.error && <p className="form-error" role="alert">{remove.error.message}</p>}
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={close} disabled={remove.isPending} autoFocus>
            Cancel
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={remove.isPending}
            onClick={() => remove.mutate(undefined, {
              onSuccess: () => {
                navigate('/settings', { replace: true })
                forgetCrop(crop.id)
              },
            })}
          >
            {remove.isPending ? 'Deleting…' : 'Delete variety'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
