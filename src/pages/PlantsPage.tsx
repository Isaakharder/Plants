import { PageHeader } from '../components/PageHeader'
import { EmptyState } from '../components/States'

export function PlantsPage() {
  return (
    <>
      <PageHeader title="Plants" description="What's physically on the plants?" />
      <EmptyState title="Coming soon" description="Plant observations will be recorded here, per variety." />
    </>
  )
}
