import { PageHeader } from '../components/PageHeader'
import { PlantsTwin } from '../features/plants/PlantsTwin'

export function PlantsPage() {
  return (
    <>
      <PageHeader title="Plants" description="What's physically on the plants?" />
      <PlantsTwin />
    </>
  )
}
