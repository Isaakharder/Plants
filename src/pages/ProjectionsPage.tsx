import { PageHeader } from '../components/PageHeader'
import { EmptyState } from '../components/States'

export function ProjectionsPage() {
  return (
    <>
      <PageHeader title="Projections" description="What am I going to harvest?" />
      <EmptyState title="Coming soon" description="Harvest projections for each variety will appear here." />
    </>
  )
}
