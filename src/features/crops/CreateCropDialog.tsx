import { Dialog } from '../../components/Dialog'
import { useOrganization } from '../organization/OrganizationProvider'
import { useCreateCrop } from './api'
import { CropForm } from './CropForm'
import { emptyCropForm } from './cropValidation'

export function CreateCropDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const organization = useOrganization()
  const create = useCreateCrop(organization.id)

  function close() {
    create.reset()
    onClose()
  }

  return (
    <Dialog open={open} title="Create variety" onClose={close}>
      <CropForm
        initialValues={emptyCropForm}
        submitLabel="Save variety"
        submitting={create.isPending}
        serverError={create.error?.message}
        onSubmit={(input) => create.mutate(input, { onSuccess: close })}
        onCancel={close}
      />
    </Dialog>
  )
}
