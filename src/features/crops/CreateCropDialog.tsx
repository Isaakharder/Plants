import { Dialog } from '../../components/Dialog'
import { useOrganization } from '../organization/OrganizationProvider'
import { useCreateCrop, usePepperTypes } from './api'
import { CropForm } from './CropForm'
import { emptyCropForm } from './cropValidation'

export function CreateCropDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const organization = useOrganization()
  const create = useCreateCrop(organization.id)
  const pepperTypes = usePepperTypes(organization.id)

  function close() {
    create.reset()
    onClose()
  }

  return (
    <Dialog open={open} title="Create variety" onClose={close}>
      <CropForm
        initialValues={emptyCropForm}
        pepperTypes={pepperTypes.data ?? []}
        submitLabel="Save variety"
        submitting={create.isPending}
        serverError={create.error?.message}
        onSubmit={(input) => create.mutate(input, { onSuccess: close })}
        onCancel={close}
      />
    </Dialog>
  )
}
